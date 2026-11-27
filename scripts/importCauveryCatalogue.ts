import 'dotenv/config';
import {
  getCentralCatalogueData,
  runCauveryCatalogueImport,
} from '../src/server/cauveryCatalogueImporter';

async function main() {
  const resume = process.argv.includes('--resume');
  const skipImages = process.argv.includes('--no-images');
  const maxPagesArg = process.argv.find((a) => a.startsWith('--max-pages='));
  const maxPages = maxPagesArg ? Number(maxPagesArg.split('=')[1]) : undefined;

  console.log(
    `[Cauvery Import] Starting ${resume ? 'resumed' : 'full'} import (downloadImages=${!skipImages}${maxPages ? `, maxPages=${maxPages}` : ''})...`
  );

  const result = await runCauveryCatalogueImport({
    resume,
    pageSize: 50,
    maxPages: Number.isFinite(maxPages) && (maxPages ?? 0) > 0 ? maxPages : undefined,
    downloadImages: !skipImages,
    onProgress: (st) => {
      if (st.currentPage % 5 === 0 || st.status === 'completed' || st.status === 'failed') {
        console.log(
          `[Cauvery Import] page ${st.currentPage}/${st.totalPages} | status=${st.status} | imported=${st.importedCount} updated=${st.updatedCount} dupes=${st.skippedDuplicatesCount} images=${st.imagesUploadedCount} imgFail=${st.imagesFailedCount} errors=${st.failedCount}`
        );
      }
    },
  });

  const central = await getCentralCatalogueData();
  const totalVariants = central.products.reduce((s, p) => s + (p.variants?.length ?? 0), 0);
  const withHostedImages = central.products.filter((p) => Boolean(p.imageUrl)).length;
  const externalImages = central.products.filter(
    (p) =>
      p.imageUrl &&
      (p.imageUrl.includes('cauverypowers.com') ||
        p.imageUrl.includes('clevup.in') ||
        p.imageUrl.includes('storage.googleapis.com'))
  ).length;
  const categories = new Set(central.products.map((p) => p.category));
  const subcategories = new Set(
    central.products.map((p) => p.subcategory).filter((x): x is string => Boolean(x))
  );

  console.log('\n=== CAUVERY POWERS CATALOGUE IMPORT REPORT ===');
  console.log(
    JSON.stringify(
      {
        status: result.status,
        storageBackend: result.storageBackend,
        pagesProcessed: `${result.currentPage}/${result.totalPages}`,
        discoveredProducts: result.discoveredCount,
        storedProducts: central.products.length,
        totalVariants,
        categoriesCount: categories.size,
        subcategoriesCount: subcategories.size,
        manufacturersCount: central.manufacturers.length,
        productsWithHostedImages: withHostedImages,
        externalImageLinksCount: externalImages,
        newImagesDownloadedAndStored: result.imagesUploadedCount,
        imageFailures: result.imagesFailedCount,
        productFailures: result.failedCount,
        skippedDuplicates: result.skippedDuplicatesCount,
        sampleErrors: result.errors.slice(0, 5),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('[Cauvery Import] Fatal error:', err);
  process.exit(1);
});
