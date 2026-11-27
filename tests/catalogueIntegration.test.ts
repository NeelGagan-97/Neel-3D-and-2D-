import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertAllowedSourceUrl,
  getCauveryImportStatus,
  getCentralCatalogueData,
} from '../src/server/cauveryCatalogueImporter';
import { sanitizeSafeCatalogueImageUrl } from '../src/utils/urlSecurity';
import {
  CATALOGUE_CATEGORIES,
  resolveProductWithVariant,
  saveCatalogueProducts,
  updateCatalogueProduct,
} from '../src/services/productCatalogueStorage';
import { computeProjectMetrics, INITIAL_PROJECTS } from '../src/data/presets';
import { computeReconciledBoq, createElectricalWire } from '../src/utils/buildingWiring';
import { assignCatalogueCableToCircuit } from '../src/utils/studioEditor';
import { buildExcelBoqSheets } from '../src/utils/excelBoqExporter';
import type { ElectricalPoint, ProjectData } from '../src/types/design';
import type { ProductCatalogueItem } from '../src/types/catalogue';

test('Outbound source allowlist strictly restricts Cauvery API and image hosts', () => {
  // Allowed authorised endpoints
  assert.doesNotThrow(() =>
    assertAllowedSourceUrl(
      'https://api.shoopy.in/api/v1/web/store/267900/super-products?page=1&size=50',
      'catalog-api'
    )
  );
  assert.doesNotThrow(() =>
    assertAllowedSourceUrl(
      'https://storage.googleapis.com/shy-pub/262162/example.jpg',
      'image'
    )
  );

  // Blocked SSRF / untrusted targets
  const blockedUrls = [
    'http://api.shoopy.in/api/v1/web/store/267900/super-products',
    'https://api.shoopy.in/api/v1/web/store/999999/super-products',
    'https://127.0.0.1/admin',
    'https://localhost:3000/api/catalogue/central',
    'https://169.254.169.254/latest/meta-data/',
    'https://evil.example.com/malicious.png',
    'https://user:pass@api.shoopy.in/api/v1/web/store/267900/super-products',
  ];
  for (const url of blockedUrls) {
    assert.throws(
      () => assertAllowedSourceUrl(url, 'catalog-api'),
      `Expected blocked catalog URL: ${url}`
    );
    assert.throws(
      () => assertAllowedSourceUrl(url, 'image'),
      `Expected blocked image URL: ${url}`
    );
  }
});

test('sanitizeSafeCatalogueImageUrl allows verified Blue Space hosted paths and blocks unsafe schemes', () => {
  const validLocal =
    '/api/catalogue/images/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
  assert.equal(sanitizeSafeCatalogueImageUrl(validLocal), validLocal);
  assert.equal(
    sanitizeSafeCatalogueImageUrl('https://xyz.supabase.co/storage/v1/object/public/catalogue-images/a.png'),
    'https://xyz.supabase.co/storage/v1/object/public/catalogue-images/a.png'
  );
  assert.equal(sanitizeSafeCatalogueImageUrl('/api/catalogue/images/../../etc/passwd'), undefined);
  assert.equal(sanitizeSafeCatalogueImageUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizeSafeCatalogueImageUrl('data:image/svg+xml,<svg/>'), undefined);
});

test('Completed Cauvery Powers import has real products, manufacturers, hosted images on disk, and zero external image links', async () => {
  const snapshot = await getCentralCatalogueData();
  const state = await getCauveryImportStatus();

  assert.equal(state.status, 'completed', 'Import state must be completed');
  assert.equal(state.failedCount, 0, 'Product failures should be 0');
  assert.equal(state.imagesFailedCount, 0, 'Image failures should be 0');
  assert.ok(snapshot.products.length >= 1500, `Expected >=1500 products, got ${snapshot.products.length}`);
  assert.ok(
    snapshot.manufacturers.length >= 35,
    `Expected >=35 manufacturers, got ${snapshot.manufacturers.length}`
  );

  const validCategorySet = new Set<string>(CATALOGUE_CATEGORIES);
  const imageDir = path.resolve(process.cwd(), 'data', 'catalogue-images');
  let productsWithHostedImage = 0;
  let totalVariants = 0;

  for (const prod of snapshot.products) {
    assert.ok(validCategorySet.has(prod.category), `Unknown category "${prod.category}" on ${prod.id}`);
    assert.ok(prod.productName.trim().length > 0, `Empty product name on ${prod.id}`);
    assert.ok(prod.manufacturer.trim().length > 0, `Empty manufacturer on ${prod.id}`);

    if (prod.unitPrice !== null) {
      assert.ok(prod.unitPrice >= 0, `Negative unitPrice on ${prod.id}`);
    }
    if (prod.gstPercent !== null) {
      assert.ok(prod.gstPercent >= 0 && prod.gstPercent <= 100, `Invalid GST on ${prod.id}`);
    }
    if (prod.discountPercent !== undefined && prod.discountPercent !== null) {
      assert.ok(
        prod.discountPercent >= 0 && prod.discountPercent <= 100,
        `Invalid discountPercent on ${prod.id}`
      );
    }

    if (prod.variants) {
      totalVariants += prod.variants.length;
    }

    // Zero external image links anywhere in product or variants
    const allImageUrls: string[] = [];
    if (prod.imageUrl) allImageUrls.push(prod.imageUrl);
    if (prod.galleryImages) allImageUrls.push(...prod.galleryImages);
    if (prod.variants) {
      for (const v of prod.variants) {
        if (v.imageUrl) allImageUrls.push(v.imageUrl);
      }
    }
    for (const imgUrl of allImageUrls) {
      assert.ok(
        imgUrl.startsWith('/api/catalogue/images/'),
        `Found non-hosted external image URL "${imgUrl}" on product ${prod.id}`
      );
      const filename = imgUrl.replace('/api/catalogue/images/', '');
      const fullPath = path.join(imageDir, filename);
      assert.ok(fs.existsSync(fullPath), `Hosted image file missing on disk: ${filename}`);
    }
    if (prod.imageUrl) productsWithHostedImage += 1;
  }

  assert.ok(totalVariants >= 2500, `Expected >=2500 variants, got ${totalVariants}`);
  assert.ok(
    productsWithHostedImage >= 1500,
    `Expected >=1500 products with hosted images, got ${productsWithHostedImage}`
  );
});

test('Variant selection, BOQ auto-population (spec, unit, price, discount, GST), and historical BOQ price preservation', () => {
  const sampleProduct: ProductCatalogueItem = {
    id: 'cat-test-switch-1',
    category: 'Switches',
    subcategory: 'Modular Switches',
    manufacturer: 'Legrand',
    brand: 'Legrand Mylinc',
    productName: 'Legrand Mylinc 10A 1-Way Modular Switch',
    modelNumber: 'LG-675501',
    sku: 'LG-675501',
    specification: '10A 240V AC 1-Module White Polycarbonate',
    rating: '10A 240V',
    wattageW: 0,
    cableSizeSqMm: null,
    dimensions: '1M',
    unit: 'Nos',
    mrp: 120,
    unitPrice: 90,
    discountPercent: 25,
    gstPercent: 18,
    mappedItemType: 'switch',
    variants: [
      {
        id: 'var-1',
        sku: 'LG-675501',
        label: '10A 1-Way White',
        displayName: '10A 1-Way White',
        mrp: 120,
        unitPrice: 90,
        discountPercent: 25,
      },
      {
        id: 'var-2',
        sku: 'LG-675502',
        label: '16A 1-Way White',
        displayName: '16A 1-Way White',
        mrp: 200,
        unitPrice: 150,
        discountPercent: 25,
      },
    ],
    source: 'cauvery-import',
    updatedAt: new Date().toISOString(),
  };

  const sampleCable: ProductCatalogueItem = {
    id: 'cat-test-cable-1',
    category: 'Cables & Wires',
    subcategory: 'House Wires',
    manufacturer: 'Polycab',
    brand: 'Polycab FR',
    productName: 'Polycab 2.5 sq.mm FR Copper Wire',
    modelNumber: 'PC-25FR',
    sku: 'PC-25FR',
    specification: 'IS 694 1100V Flame Retardant Copper',
    rating: '1100V',
    wattageW: null,
    cableSizeSqMm: 2.5,
    dimensions: '',
    unit: 'm',
    mrp: 40,
    unitPrice: 32,
    discountPercent: 20,
    gstPercent: 18,
    mappedItemType: 'switchboard',
    source: 'cauvery-import',
    updatedAt: new Date().toISOString(),
  };

  saveCatalogueProducts([sampleProduct, sampleCable]);

  // Select second variant (16A, MRP 200, Selling 150, 25% discount, 18% GST)
  const resolvedVariant = resolveProductWithVariant(sampleProduct, 'LG-675502');
  assert.equal(resolvedVariant.unitPrice, 150);
  assert.equal(resolvedVariant.mrp, 200);
  assert.equal(resolvedVariant.discountPercent, 25);
  assert.equal(resolvedVariant.modelNumber, 'LG-675502');

  // Build project with 2 placed points using snapshotted historical price (₹150) + 1 cable route
  const base: ProjectData = structuredClone(INITIAL_PROJECTS[0]);
  const snapshotTime = '2026-01-15T10:00:00.000Z';
  const pt1: ElectricalPoint = {
    id: 'pt-hist-1',
    floor: 1,
    code: 'SW-91',
    name: `${resolvedVariant.brand} ${resolvedVariant.productName}`,
    itemType: 'switch',
    category: 'Switches',
    roomId: base.rooms[0].id,
    x: 1,
    y: 1,
    z: 1.2,
    rotation: 0,
    wattage: 0,
    voltage: 230,
    circuit: 'CKT-L1 (Lighting)',
    unit: resolvedVariant.unit,
    unitCost: resolvedVariant.unitPrice!,
    mrp: resolvedVariant.mrp,
    discountPercent: resolvedVariant.discountPercent,
    productId: resolvedVariant.id,
    manufacturer: resolvedVariant.manufacturer,
    brand: resolvedVariant.brand,
    modelNumber: resolvedVariant.modelNumber,
    specification: resolvedVariant.specification,
    gstPercent: resolvedVariant.gstPercent ?? undefined,
    variantSku: resolvedVariant.sku ?? undefined,
    priceCapturedAt: snapshotTime,
  };
  const pt2: ElectricalPoint = { ...pt1, id: 'pt-hist-2', code: 'SW-92', x: 4, y: 1 };

  let project: ProjectData = {
    ...base,
    points: [pt1, pt2],
    wires: [],
  };

  const wire = createElectricalWire({
    project,
    fromPoint: pt1,
    toPoint: pt2,
    circuit: 'CKT-L1 (Lighting)',
    category: 'phase',
    cableSizeSqMm: 2.5,
  });
  project = { ...project, wires: [wire] };
  project = assignCatalogueCableToCircuit(project, sampleCable, 'CKT-L1 (Lighting)');

  // Now simulate admin updating the catalogue prices later (₹150 -> ₹299, cable ₹32 -> ₹75)
  updateCatalogueProduct(sampleProduct.id, { unitPrice: 299, mrp: 350, discountPercent: 14.57 });
  updateCatalogueProduct(sampleCable.id, { unitPrice: 75, mrp: 90 });

  // Verify saved project BOQ preserves exact historical prices (₹150 and ₹32) and auto-populated discount & GST
  const metrics = computeProjectMetrics(project);
  const swMetricRow = metrics.boqRows.find((r) => r.productId === sampleProduct.id);
  assert.ok(swMetricRow, 'Expected catalogue switch row in computeProjectMetrics');
  assert.equal(swMetricRow.quantity, 2);
  assert.equal(swMetricRow.unit, 'Nos');
  assert.equal(swMetricRow.unitPrice, 150, 'Historical BOQ unit price must not change after catalogue edit');
  assert.equal(swMetricRow.estimatedCost, 300);
  assert.equal(swMetricRow.discountPercent, 25);
  assert.equal(swMetricRow.gstPercent, 18);
  assert.equal(swMetricRow.priceCapturedAt, snapshotTime);

  const reconciled = computeReconciledBoq(project);
  const swBoqRow = reconciled.rows.find((r) => r.model === 'LG-675502');
  assert.ok(swBoqRow, 'Expected switch row in computeReconciledBoq');
  assert.equal(swBoqRow.unitPrice, 150);
  assert.equal(swBoqRow.mrp, 200);
  assert.equal(swBoqRow.discountPercent, 25);
  assert.equal(swBoqRow.gstPercent, 18);
  assert.equal(swBoqRow.subtotal, 300);
  assert.equal(swBoqRow.gstAmount, 54);
  assert.equal(swBoqRow.total, 354);

  const cableBoqRow = reconciled.rows.find((r) => r.kind === 'cable');
  assert.ok(cableBoqRow, 'Expected cable row in computeReconciledBoq');
  assert.equal(cableBoqRow.unitPrice, 32, 'Historical cable price must be preserved');
  assert.equal(cableBoqRow.mrp, 40);
  assert.equal(cableBoqRow.discountPercent, 20);
  assert.equal(cableBoqRow.gstPercent, 18);

  // Verify Excel BOQ export includes MRP and Discount (%) columns with accurate values
  const sheets = buildExcelBoqSheets(project);
  const sheet1 = sheets[0];
  const headerRow = sheet1.rows[3];
  assert.ok(headerRow.includes('MRP (₹)'), 'Excel BOQ must include MRP column');
  assert.ok(headerRow.includes('Discount (%)'), 'Excel BOQ must include Discount % column');
  const swExcelRow = sheet1.rows.find((r) => r.includes('LG-675502'));
  assert.ok(swExcelRow, 'Expected switch row in Excel BOQ');
  assert.equal(swExcelRow[headerRow.indexOf('MRP (₹)')], 200);
  assert.equal(swExcelRow[headerRow.indexOf('Discount (%)')], 25);
  assert.equal(swExcelRow[headerRow.indexOf('Price/Unit (₹)')], 150);
});
