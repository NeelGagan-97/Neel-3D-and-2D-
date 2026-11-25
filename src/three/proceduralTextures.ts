import * as THREE from 'three';

export interface ArchitecturalTextureSet {
  wood: THREE.CanvasTexture;
  tile: THREE.CanvasTexture;
  terrazzo: THREE.CanvasTexture;
  stone: THREE.CanvasTexture;
  dispose: () => void;
}

function makeCanvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for procedural architectural textures.');
  }
  return [canvas, ctx];
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  const safeMax = Number.isFinite(maxAnisotropy) && maxAnisotropy >= 1 ? maxAnisotropy : 1;
  tex.anisotropy = Math.max(1, Math.min(8, safeMax));
  tex.needsUpdate = true;
  return tex;
}

export function createArchitecturalTextures(maxAnisotropy: number): ArchitecturalTextureSet {
  // 1. Warm Engineered Teak / Oak Wood Planks
  const [woodCanvas, wCtx] = makeCanvas(256);
  wCtx.fillStyle = '#6B4C35';
  wCtx.fillRect(0, 0, 256, 256);
  const plankH = 32;
  for (let row = 0; row < 8; row++) {
    const shade = 92 + ((row * 17) % 24);
    wCtx.fillStyle = `rgb(${shade + 22}, ${shade - 4}, ${shade - 28})`;
    wCtx.fillRect(0, row * plankH, 256, plankH - 1.5);
    // Subtle grain streaks
    wCtx.strokeStyle = 'rgba(42, 24, 12, 0.16)';
    wCtx.lineWidth = 1;
    for (let g = 0; g < 5; g++) {
      const gy = row * plankH + 5 + g * 5;
      wCtx.beginPath();
      wCtx.moveTo(0, gy);
      wCtx.bezierCurveTo(85, gy + ((row + g) % 3) - 1, 170, gy - ((row + g) % 2), 256, gy);
      wCtx.stroke();
    }
    // Plank seam
    wCtx.fillStyle = '#3B271A';
    wCtx.fillRect(0, (row + 1) * plankH - 1.5, 256, 1.5);
    const jointX = ((row * 97) % 200) + 24;
    wCtx.fillRect(jointX, row * plankH, 1.5, plankH);
  }
  const wood = finalizeTexture(woodCanvas, 3, 3, maxAnisotropy);

  // 2. Porcelain Kitchen Tile (Cool Travertine Grid)
  const [tileCanvas, tCtx] = makeCanvas(256);
  tCtx.fillStyle = '#B8B4AA';
  tCtx.fillRect(0, 0, 256, 256);
  const cell = 64;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const delta = ((x * 7 + y * 13) % 10) - 5;
      tCtx.fillStyle = `rgb(${198 + delta}, ${194 + delta}, ${186 + delta})`;
      tCtx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  const tile = finalizeTexture(tileCanvas, 2.5, 2.5, maxAnisotropy);

  // 3. Modern Terrazzo (Dining / Passage)
  const [terCanvas, terCtx] = makeCanvas(256);
  terCtx.fillStyle = '#C8C6BE';
  terCtx.fillRect(0, 0, 256, 256);
  const chips = ['#8E9AAF', '#D9A05B', '#5C677D', '#EFECE6', '#415A77'];
  for (let i = 0; i < 190; i++) {
    const cx = (i * 53) % 256;
    const cy = (i * 97) % 256;
    const r = 1.5 + (i % 4);
    terCtx.fillStyle = chips[i % chips.length];
    terCtx.beginPath();
    terCtx.ellipse(cx, cy, r, r * 0.7, (i % 6) * 0.5, 0, Math.PI * 2);
    terCtx.fill();
  }
  const terrazzo = finalizeTexture(terCanvas, 2.5, 2.5, maxAnisotropy);

  // 4. Honed Architectural Slate Stone (Bathroom / Balcony)
  const [stoneCanvas, sCtx] = makeCanvas(256);
  sCtx.fillStyle = '#475569';
  sCtx.fillRect(0, 0, 256, 256);
  const sCell = 64;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = 78 + ((x * 11 + y * 5) % 14);
      sCtx.fillStyle = `rgb(${v}, ${v + 8}, ${v + 18})`;
      sCtx.fillRect(x * sCell + 1.5, y * sCell + 1.5, sCell - 3, sCell - 3);
    }
  }
  const stone = finalizeTexture(stoneCanvas, 2.5, 2.5, maxAnisotropy);

  return {
    wood,
    tile,
    terrazzo,
    stone,
    dispose: () => {
      wood.dispose();
      tile.dispose();
      terrazzo.dispose();
      stone.dispose();
    },
  };
}
