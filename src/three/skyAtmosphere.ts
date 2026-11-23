import * as THREE from 'three';
import { LightingMode } from '../types/design';

export interface SkyLightingPreset {
  mode: LightingMode;
  zenithColor: number;
  midSkyColor: number;
  horizonColor: number;
  groundColor: number;
  fogColor: number;
  fogDensity: number;
  sunDirection: [number, number, number];
  sunColor: number;
  sunHaloColor: number;
  sunSize: number;
  starIntensity: number;
  keyLightColor: number;
  keyLightIntensity: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  rimLightColor: number;
  rimLightIntensity: number;
  eveningFillIntensity: number;
  exposure: number;
  cloudTopColor: number;
  cloudBottomColor: number;
  cloudOpacity: number;
  birdColor: number;
  birdsVisible: boolean;
}

export const SKY_PRESETS: Record<LightingMode, SkyLightingPreset> = {
  sunrise: {
    mode: 'sunrise',
    zenithColor: 0x1d4b82,
    midSkyColor: 0xe28a6c,
    horizonColor: 0xffd79a,
    groundColor: 0x1d2536,
    fogColor: 0xd99e7c,
    fogDensity: 0.0062,
    sunDirection: [0.74, 0.21, -0.64],
    sunColor: 0xffe49e,
    sunHaloColor: 0xff9f52,
    sunSize: 1.35,
    starIntensity: 0.08,
    keyLightColor: 0xffbe76,
    keyLightIntensity: 1.75,
    hemiSkyColor: 0xffd2a6,
    hemiGroundColor: 0x3b3348,
    hemiIntensity: 0.9,
    rimLightColor: 0x7aa9e8,
    rimLightIntensity: 0.6,
    eveningFillIntensity: 0.55,
    exposure: 1.12,
    cloudTopColor: 0xffe8d1,
    cloudBottomColor: 0xd88a78,
    cloudOpacity: 0.92,
    birdColor: 0x2a2433,
    birdsVisible: true,
  },
  daylight: {
    mode: 'daylight',
    zenithColor: 0x1a63c6,
    midSkyColor: 0x62b0ea,
    horizonColor: 0xd9ecff,
    groundColor: 0x1e2c42,
    fogColor: 0xb7d9f7,
    fogDensity: 0.0045,
    sunDirection: [0.46, 0.72, 0.52],
    sunColor: 0xfffbe6,
    sunHaloColor: 0xfff0ba,
    sunSize: 1.05,
    starIntensity: 0.0,
    keyLightColor: 0xfff5e2,
    keyLightIntensity: 2.05,
    hemiSkyColor: 0xd4edff,
    hemiGroundColor: 0x2c3e52,
    hemiIntensity: 1.05,
    rimLightColor: 0x7cb9ff,
    rimLightIntensity: 0.65,
    eveningFillIntensity: 0,
    exposure: 1.14,
    cloudTopColor: 0xffffff,
    cloudBottomColor: 0xc2d4e8,
    cloudOpacity: 0.94,
    birdColor: 0x334155,
    birdsVisible: true,
  },
  sunset: {
    mode: 'sunset',
    zenithColor: 0x181b47,
    midSkyColor: 0x9b3e62,
    horizonColor: 0xff7a45,
    groundColor: 0x161424,
    fogColor: 0xb8584c,
    fogDensity: 0.0068,
    sunDirection: [-0.76, 0.16, -0.63],
    sunColor: 0xffb36b,
    sunHaloColor: 0xff5a2c,
    sunSize: 1.5,
    starIntensity: 0.22,
    keyLightColor: 0xff8c4d,
    keyLightIntensity: 1.55,
    hemiSkyColor: 0xff9b71,
    hemiGroundColor: 0x2a1f36,
    hemiIntensity: 0.78,
    rimLightColor: 0x7f65c4,
    rimLightIntensity: 0.55,
    eveningFillIntensity: 1.55,
    exposure: 1.08,
    cloudTopColor: 0xffb07d,
    cloudBottomColor: 0x5d3559,
    cloudOpacity: 0.92,
    birdColor: 0x1c1526,
    birdsVisible: true,
  },
  evening: {
    mode: 'evening',
    zenithColor: 0x040712,
    midSkyColor: 0x0c1730,
    horizonColor: 0x182b4d,
    groundColor: 0x050914,
    fogColor: 0x0a1326,
    fogDensity: 0.0072,
    sunDirection: [-0.52, 0.56, -0.64],
    sunColor: 0xdbeafe,
    sunHaloColor: 0x60a5fa,
    sunSize: 0.72,
    starIntensity: 1.0,
    keyLightColor: 0x7c93b8,
    keyLightIntensity: 0.52,
    hemiSkyColor: 0x3b5885,
    hemiGroundColor: 0x111827,
    hemiIntensity: 0.4,
    rimLightColor: 0x60a5fa,
    rimLightIntensity: 0.55,
    eveningFillIntensity: 2.65,
    exposure: 1.05,
    cloudTopColor: 0x26395c,
    cloudBottomColor: 0x111b30,
    cloudOpacity: 0.55,
    birdColor: 0x0f172a,
    birdsVisible: false,
  },
};

interface CloudInstance {
  group: THREE.Group;
  angle: number;
  radius: number;
  altitude: number;
  angularSpeed: number;
  bobPhase: number;
  bobAmp: number;
}

interface BirdInstance {
  group: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  orbitRadiusX: number;
  orbitRadiusZ: number;
  centerX: number;
  centerZ: number;
  baseY: number;
  angularSpeed: number;
  phase: number;
  flapSpeed: number;
  flapPhase: number;
  bobAmp: number;
}

export interface SkyAtmosphereHandles {
  root: THREE.Group;
  applyMode: (mode: LightingMode) => SkyLightingPreset;
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
}

function createSunGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.14, 'rgba(255, 250, 224, 0.96)');
    grad.addColorStop(0.32, 'rgba(255, 210, 140, 0.45)');
    grad.addColorStop(0.62, 'rgba(255, 160, 90, 0.14)');
    grad.addColorStop(1.0, 'rgba(255, 140, 60, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Reusable scratch vectors (zero GC in render loop)
const _sunDir = new THREE.Vector3();
const _nextBirdPos = new THREE.Vector3();

/**
 * Procedural atmospheric sky dome with Sun/Sunrise/Sunset/Night shader,
 * radiant solar corona, drifting volumetric multi-puff clouds, and soaring flapping birds.
 */
export function createSkyAtmosphere(sceneScale: number): SkyAtmosphereHandles {
  const root = new THREE.Group();
  root.name = 'SkyAtmosphere';

  const skyRadius = 115 * sceneScale;

  // 1. Custom GLSL Atmospheric Sky Dome Shader
  const skyGeo = new THREE.SphereGeometry(skyRadius, 36, 24);
  const skyUniforms = {
    uZenithColor: { value: new THREE.Color(SKY_PRESETS.daylight.zenithColor) },
    uMidSkyColor: { value: new THREE.Color(SKY_PRESETS.daylight.midSkyColor) },
    uHorizonColor: { value: new THREE.Color(SKY_PRESETS.daylight.horizonColor) },
    uGroundColor: { value: new THREE.Color(SKY_PRESETS.daylight.groundColor) },
    uSunDirection: { value: new THREE.Vector3(...SKY_PRESETS.daylight.sunDirection).normalize() },
    uSunColor: { value: new THREE.Color(SKY_PRESETS.daylight.sunColor) },
    uSunHaloColor: { value: new THREE.Color(SKY_PRESETS.daylight.sunHaloColor) },
    uStarIntensity: { value: 0.0 },
    uTime: { value: 0.0 },
  };

  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uZenithColor;
      uniform vec3 uMidSkyColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uGroundColor;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform vec3 uSunHaloColor;
      uniform float uStarIntensity;
      uniform float uTime;

      varying vec3 vWorldDir;

      float hash31(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec3 dir = normalize(vWorldDir);
        float h = dir.y;

        // Smooth vertical sky gradient with soft ground horizon blend
        vec3 skyCol;
        if (h >= 0.0) {
          float tMid = smoothstep(0.0, 0.28, h);
          float tTop = smoothstep(0.18, 0.88, h);
          skyCol = mix(uHorizonColor, uMidSkyColor, tMid);
          skyCol = mix(skyCol, uZenithColor, tTop);
        } else {
          float tGround = smoothstep(0.0, -0.35, h);
          skyCol = mix(uHorizonColor * 0.72, uGroundColor, tGround);
        }

        // Solar / Lunar atmospheric scattering & crisp disc
        vec3 sunDir = normalize(uSunDirection);
        float sunDot = max(dot(dir, sunDir), 0.0);
        float horizonGlow = pow(sunDot, 4.0) * smoothstep(-0.12, 0.35, h) * 0.55;
        float corona = pow(sunDot, 28.0) * 0.65;
        float coreDisc = smoothstep(0.9978, 0.9994, sunDot) * 1.45;

        skyCol += uSunHaloColor * (horizonGlow + corona);
        skyCol += uSunColor * coreDisc;

        // Subtle procedural starfield during Evening / twilight
        if (uStarIntensity > 0.01 && h > 0.06) {
          vec3 starCell = floor(dir * 165.0);
          float rnd = hash31(starCell);
          if (rnd > 0.992) {
            float twinkle = 0.65 + 0.35 * sin(uTime * 2.2 + rnd * 90.0);
            float starVis = smoothstep(0.06, 0.35, h) * uStarIntensity * twinkle;
            skyCol += vec3(0.88, 0.94, 1.0) * starVis * 0.9;
          }
        }

        gl_FragColor = vec4(skyCol, 1.0);
      }
    `,
  });

  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.renderOrder = -10;
  skyDome.frustumCulled = false;
  root.add(skyDome);

  // 2. Radiant Sun / Moon Corona Sprite
  const sunGlowTex = createSunGlowTexture();
  const sunSpriteMat = new THREE.SpriteMaterial({
    map: sunGlowTex,
    color: SKY_PRESETS.daylight.sunColor,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const sunSprite = new THREE.Sprite(sunSpriteMat);
  sunSprite.frustumCulled = false;
  root.add(sunSprite);

  // 3. Drifting Volumetric Multi-Puff Procedural Clouds (shared geometry & materials)
  const cloudsGroup = new THREE.Group();
  cloudsGroup.name = 'ProceduralClouds';
  root.add(cloudsGroup);

  const cloudPuffGeo = new THREE.IcosahedronGeometry(1, 2);
  const cloudTopMat = new THREE.MeshLambertMaterial({
    color: SKY_PRESETS.daylight.cloudTopColor,
    transparent: true,
    opacity: SKY_PRESETS.daylight.cloudOpacity,
    depthWrite: false,
    fog: false,
  });
  const cloudBottomMat = new THREE.MeshLambertMaterial({
    color: SKY_PRESETS.daylight.cloudBottomColor,
    transparent: true,
    opacity: SKY_PRESETS.daylight.cloudOpacity * 0.92,
    depthWrite: false,
    fog: false,
  });

  const clouds: CloudInstance[] = [];
  const cloudCount = 16;

  // Deterministic pseudo-random helper so cloud formations look sculpted & repeatable
  const seeded = (seed: number) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  for (let i = 0; i < cloudCount; i++) {
    const cluster = new THREE.Group();
    const baseScale = (3.4 + seeded(i + 1) * 3.8) * sceneScale;
    const puffCount = 5 + Math.floor(seeded(i + 17) * 3);

    for (let p = 0; p < puffCount; p++) {
      const t = (p / Math.max(1, puffCount - 1)) - 0.5; // -0.5 .. 0.5
      const puffRx = baseScale * (0.7 + (1 - Math.abs(t) * 1.1) * 0.65);
      const puffRy = baseScale * (0.36 + (1 - Math.abs(t) * 1.2) * 0.34);
      const puffRz = baseScale * (0.55 + seeded(i * 11 + p) * 0.35);

      const topPuff = new THREE.Mesh(cloudPuffGeo, cloudTopMat);
      topPuff.scale.set(puffRx, puffRy, puffRz);
      topPuff.position.set(
        t * baseScale * 2.4 + (seeded(i * 7 + p) - 0.5) * baseScale * 0.35,
        (0.18 - Math.abs(t) * 0.32) * baseScale,
        (seeded(i * 13 + p) - 0.5) * baseScale * 0.55
      );
      cluster.add(topPuff);

      // Soft shaded cloud underside puff for dimensional volume
      if (p % 2 === 0) {
        const underPuff = new THREE.Mesh(cloudPuffGeo, cloudBottomMat);
        underPuff.scale.set(puffRx * 0.92, puffRy * 0.55, puffRz * 0.9);
        underPuff.position.set(
          topPuff.position.x,
          topPuff.position.y - puffRy * 0.55,
          topPuff.position.z
        );
        cluster.add(underPuff);
      }
    }

    const angle = (i / cloudCount) * Math.PI * 2 + seeded(i + 41) * 0.35;
    const radius = (58 + seeded(i + 73) * 34) * sceneScale;
    const altitude = (22 + seeded(i + 97) * 24) * sceneScale;
    const angularSpeed = (0.008 + seeded(i + 131) * 0.009) * (i % 3 === 0 ? -1 : 1);

    cluster.position.set(
      Math.cos(angle) * radius,
      altitude,
      Math.sin(angle) * radius
    );
    cluster.lookAt(0, altitude, 0);
    cloudsGroup.add(cluster);

    clouds.push({
      group: cluster,
      angle,
      radius,
      altitude,
      angularSpeed,
      bobPhase: seeded(i + 163) * Math.PI * 2,
      bobAmp: (0.45 + seeded(i + 191) * 0.55) * sceneScale,
    });
  }

  // 4. Animated Soaring Background Birds (Multi-part articulated wings)
  const birdsGroup = new THREE.Group();
  birdsGroup.name = 'SoaringBirds';
  root.add(birdsGroup);

  const birdMat = new THREE.MeshBasicMaterial({
    color: SKY_PRESETS.daylight.birdColor,
    side: THREE.DoubleSide,
    fog: false,
  });

  // Slender tapered bird body + sculpted swept wing geometry
  const birdBodyGeo = new THREE.ConeGeometry(0.11 * sceneScale, 0.85 * sceneScale, 5);
  birdBodyGeo.rotateX(Math.PI / 2);

  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.14 * sceneScale);
  wingShape.quadraticCurveTo(0.45 * sceneScale, 0.22 * sceneScale, 1.05 * sceneScale, -0.08 * sceneScale);
  wingShape.quadraticCurveTo(0.55 * sceneScale, -0.14 * sceneScale, 0, -0.16 * sceneScale);
  wingShape.closePath();
  const rightWingGeo = new THREE.ShapeGeometry(wingShape);
  rightWingGeo.rotateX(-Math.PI / 2);

  const leftWingShape = new THREE.Shape();
  leftWingShape.moveTo(0, 0.14 * sceneScale);
  leftWingShape.quadraticCurveTo(-0.45 * sceneScale, 0.22 * sceneScale, -1.05 * sceneScale, -0.08 * sceneScale);
  leftWingShape.quadraticCurveTo(-0.55 * sceneScale, -0.14 * sceneScale, 0, -0.16 * sceneScale);
  leftWingShape.closePath();
  const leftWingGeo = new THREE.ShapeGeometry(leftWingShape);
  leftWingGeo.rotateX(-Math.PI / 2);

  const birds: BirdInstance[] = [];
  const flockDefs = [
    { count: 6, centerX: -12 * sceneScale, centerZ: -16 * sceneScale, rx: 38 * sceneScale, rz: 30 * sceneScale, baseY: 18 * sceneScale, speed: 0.14 },
    { count: 5, centerX: 15 * sceneScale, centerZ: -20 * sceneScale, rx: 44 * sceneScale, rz: 34 * sceneScale, baseY: 25 * sceneScale, speed: -0.11 },
    { count: 4, centerX: 0, centerZ: -26 * sceneScale, rx: 52 * sceneScale, rz: 28 * sceneScale, baseY: 31 * sceneScale, speed: 0.09 },
  ];

  let birdIdx = 0;
  flockDefs.forEach((flock, fIdx) => {
    for (let j = 0; j < flock.count; j++) {
      const bird = new THREE.Group();
      const scaleJitter = 0.78 + seeded(birdIdx + 301) * 0.44;
      bird.scale.setScalar(scaleJitter);

      const body = new THREE.Mesh(birdBodyGeo, birdMat);
      bird.add(body);

      const leftWingPivot = new THREE.Group();
      const leftWingMesh = new THREE.Mesh(leftWingGeo, birdMat);
      leftWingPivot.add(leftWingMesh);
      bird.add(leftWingPivot);

      const rightWingPivot = new THREE.Group();
      const rightWingMesh = new THREE.Mesh(rightWingGeo, birdMat);
      rightWingPivot.add(rightWingMesh);
      bird.add(rightWingPivot);

      birdsGroup.add(bird);

      const phaseOffset = fIdx * 2.1 + j * 0.26 + seeded(birdIdx + 353) * 0.14;
      birds.push({
        group: bird,
        leftWing: leftWingPivot,
        rightWing: rightWingPivot,
        orbitRadiusX: flock.rx + (j - flock.count / 2) * 1.9 * sceneScale,
        orbitRadiusZ: flock.rz + (seeded(birdIdx + 401) - 0.5) * 4.5 * sceneScale,
        centerX: flock.centerX,
        centerZ: flock.centerZ,
        baseY: flock.baseY + (seeded(birdIdx + 433) - 0.5) * 3.8 * sceneScale,
        angularSpeed: flock.speed * (0.94 + seeded(birdIdx + 467) * 0.12),
        phase: phaseOffset,
        flapSpeed: 5.4 + seeded(birdIdx + 503) * 2.2,
        flapPhase: seeded(birdIdx + 541) * Math.PI * 2,
        bobAmp: (0.45 + seeded(birdIdx + 577) * 0.45) * sceneScale,
      });

      birdIdx += 1;
    }
  });

  const applyMode = (mode: LightingMode): SkyLightingPreset => {
    const preset = SKY_PRESETS[mode] ?? SKY_PRESETS.daylight;

    skyUniforms.uZenithColor.value.setHex(preset.zenithColor);
    skyUniforms.uMidSkyColor.value.setHex(preset.midSkyColor);
    skyUniforms.uHorizonColor.value.setHex(preset.horizonColor);
    skyUniforms.uGroundColor.value.setHex(preset.groundColor);
    skyUniforms.uSunColor.value.setHex(preset.sunColor);
    skyUniforms.uSunHaloColor.value.setHex(preset.sunHaloColor);
    skyUniforms.uStarIntensity.value = preset.starIntensity;

    _sunDir.set(...preset.sunDirection).normalize();
    skyUniforms.uSunDirection.value.copy(_sunDir);

    // Place radiant sun/moon sprite along the sky sphere perimeter
    sunSprite.position.copy(_sunDir).multiplyScalar(skyRadius * 0.86);
    const spriteScale = 24 * preset.sunSize * sceneScale;
    sunSprite.scale.set(spriteScale, spriteScale, 1);
    sunSpriteMat.color.setHex(preset.sunColor);
    sunSpriteMat.opacity = mode === 'evening' ? 0.48 : 0.92;

    cloudTopMat.color.setHex(preset.cloudTopColor);
    cloudTopMat.opacity = preset.cloudOpacity;
    cloudBottomMat.color.setHex(preset.cloudBottomColor);
    cloudBottomMat.opacity = preset.cloudOpacity * 0.9;

    birdMat.color.setHex(preset.birdColor);
    birdsGroup.visible = preset.birdsVisible;

    return preset;
  };

  const update = (dt: number, elapsed: number) => {
    skyUniforms.uTime.value = elapsed;

    // Gentle cloud drift around the sky dome
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      c.angle += c.angularSpeed * dt;
      const y = c.altitude + Math.sin(elapsed * 0.35 + c.bobPhase) * c.bobAmp;
      c.group.position.set(
        Math.cos(c.angle) * c.radius,
        y,
        Math.sin(c.angle) * c.radius
      );
      c.group.lookAt(0, y, 0);
    }

    // Graceful bird flight paths with alternating flapping and gliding
    if (birdsGroup.visible) {
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        const a = b.phase + elapsed * b.angularSpeed;
        const x = b.centerX + Math.cos(a) * b.orbitRadiusX;
        const z = b.centerZ + Math.sin(a) * b.orbitRadiusZ;
        const y = b.baseY + Math.sin(a * 2.0 + b.flapPhase) * b.bobAmp;
        b.group.position.set(x, y, z);

        // Compute tangent look-ahead point along orbit so bird faces direction of flight
        const aNext = a + (b.angularSpeed >= 0 ? 0.04 : -0.04);
        _nextBirdPos.set(
          b.centerX + Math.cos(aNext) * b.orbitRadiusX,
          b.baseY + Math.sin(aNext * 2.0 + b.flapPhase) * b.bobAmp,
          b.centerZ + Math.sin(aNext) * b.orbitRadiusZ
        );
        b.group.lookAt(_nextBirdPos);

        // Periodic glide envelope (smoothly alternates between flapping and soaring)
        const glideCycle = 0.5 + 0.5 * Math.sin(elapsed * 0.65 + b.flapPhase);
        const flapAmp = 0.14 + glideCycle * 0.52;
        const wingAngle = Math.sin(elapsed * b.flapSpeed + b.flapPhase) * flapAmp;
        b.leftWing.rotation.z = -wingAngle;
        b.rightWing.rotation.z = wingAngle;
      }
    }
  };

  // Initialize default placement immediately
  applyMode('daylight');
  update(0, 0);

  const dispose = () => {
    skyGeo.dispose();
    skyMat.dispose();
    sunGlowTex.dispose();
    sunSpriteMat.dispose();
    cloudPuffGeo.dispose();
    cloudTopMat.dispose();
    cloudBottomMat.dispose();
    birdBodyGeo.dispose();
    leftWingGeo.dispose();
    rightWingGeo.dispose();
    birdMat.dispose();
  };

  return {
    root,
    applyMode,
    update,
    dispose,
  };
}
