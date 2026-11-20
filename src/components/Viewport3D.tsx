import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CATALOG_MAP, findRoomAtPoint, siteToMeters } from '../data/presets';
import { buildArchitecturalScene, BuiltSceneHandles } from '../three/architecturalBuilder';
import { ArchitecturalTextureSet, createArchitecturalTextures } from '../three/proceduralTextures';
import {
  CameraMode,
  ElectricalItemType,
  ElectricalPoint,
  LightingMode,
  ProjectData,
} from '../types/design';
import { FloorPlan2D } from './FloorPlan2D';

interface Viewport3DProps {
  project: ProjectData;
  selectedPointId?: string | null;
  cameraMode?: CameraMode;
  lightingMode?: LightingMode;
  zoom?: number;
  pendingPlaceItem?: ElectricalItemType | null;
  previewOnly?: boolean;
  showPins?: boolean;
  onSelectPoint?: (pointId: string) => void;
  onPlacePointAt?: (itemType: ElectricalItemType, x: number, y: number, roomId: string) => void;
}

interface ProjectedPin {
  id: string;
  code: string;
  icon: string;
  isSelected: boolean;
  isHighPower: boolean;
  x: number;
  y: number;
  visible: boolean;
}

// Reusable math objects (zero GC in loop)
const _projVec = new THREE.Vector3();
const _targetCamPos = new THREE.Vector3();
const _targetLook = new THREE.Vector3();
const _rayMouse = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _planeHit = new THREE.Vector3();

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export const Viewport3D: React.FC<Viewport3DProps> = ({
  project,
  selectedPointId = null,
  cameraMode = 'orbit',
  lightingMode = 'daylight',
  zoom = 100,
  pendingPlaceItem = null,
  previewOnly = false,
  showPins = true,
  onSelectPoint,
  onPlacePointAt,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [pins, setPins] = useState<ProjectedPin[]>([]);

  // Mutable refs so scene callbacks never recreate WebGL context
  const onSelectRef = useRef(onSelectPoint);
  const onPlaceRef = useRef(onPlacePointAt);
  const pendingPlaceRef = useRef(pendingPlaceItem);
  const projectRef = useRef(project);
  const selectedIdRef = useRef(selectedPointId);
  const cameraModeRef = useRef(cameraMode);
  const lightingModeRef = useRef(lightingMode);
  const showPinsRef = useRef(showPins && !previewOnly);

  onSelectRef.current = onSelectPoint;
  onPlaceRef.current = onPlacePointAt;
  pendingPlaceRef.current = pendingPlaceItem;
  projectRef.current = project;
  selectedIdRef.current = selectedPointId;
  cameraModeRef.current = cameraMode;
  lightingModeRef.current = lightingMode;
  showPinsRef.current = showPins && !previewOnly;

  // Featured pins to display cleanly without visual clutter
  const featuredPoints = useMemo<ElectricalPoint[]>(() => {
    if (previewOnly || !showPins) return [];
    const byPriority: ElectricalPoint[] = [];
    const addIf = (p?: ElectricalPoint) => {
      if (p && !byPriority.some((x) => x.id === p.id)) byPriority.push(p);
    };
    // Always show selected point first
    if (selectedPointId) {
      addIf(project.points.find((p) => p.id === selectedPointId));
    }
    // Plus 4 representative anchors across categories
    addIf(project.points.find((p) => p.itemType === 'ceiling_fan'));
    addIf(project.points.find((p) => p.itemType === 'split_ac'));
    addIf(project.points.find((p) => p.itemType === 'switchboard'));
    addIf(project.points.find((p) => p.itemType === 'socket_16a' || p.itemType === 'geyser'));
    return byPriority.slice(0, 5);
  }, [project.points, selectedPointId, previewOnly, showPins]);

  const featuredRef = useRef(featuredPoints);
  featuredRef.current = featuredPoints;

  // Store Three.js engine handles across prop updates
  const engineRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    textures: ArchitecturalTextureSet;
    built: BuiltSceneHandles | null;
    keyLight: THREE.DirectionalLight;
    hemiLight: THREE.HemisphereLight;
    rimLight: THREE.DirectionalLight;
    eveningFill: THREE.PointLight;
    isSoftwareGl: boolean;
    requestRender: () => void;
    transitionCamera: (mode: CameraMode, zoomPct: number) => void;
    rebuildScene: () => void;
  } | null>(null);

  // Initialize Three.js WebGLRenderer once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
        alpha: false,
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 220);

    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    // Scene + Fog + RoomEnvironment Studio Reflections
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080f20);
    scene.fog = new THREE.FogExp2(0x080f20, 0.018);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    // Camera
    const camera = new THREE.PerspectiveCamera(previewOnly ? 38 : 42, width / height, 0.1, 140);
    camera.position.set(11.5, 11.2, 13.0);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 4;
    controls.maxDistance = 36;
    controls.enablePan = !previewOnly;
    controls.target.set(0, 0.6, 0);
    controls.update();

    // CAD Ground Grid (below slab at y = -0.25)
    const grid = new THREE.GridHelper(44, 44, 0x00a8ff, 0x1d2b44);
    grid.position.y = -0.25;
    if (Array.isArray(grid.material)) {
      grid.material.forEach((m) => {
        m.transparent = true;
        m.opacity = 0.35;
      });
    } else {
      grid.material.transparent = true;
      grid.material.opacity = 0.35;
    }
    scene.add(grid);

    // 3-Point Warm/Cool Studio Architectural Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xcbe8ff, 0x1e293b, 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e0, 1.85);
    keyLight.position.set(14, 22, 12);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.left = -14;
      keyLight.shadow.camera.right = 14;
      keyLight.shadow.camera.top = 14;
      keyLight.shadow.camera.bottom = -14;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.65);
    rimLight.position.set(-14, 10, -12);
    scene.add(rimLight);

    // Warm interior ambiance light for Evening mode
    const eveningFill = new THREE.PointLight(0xffb454, 0, 22, 1.4);
    eveningFill.position.set(0, 3.2, 0);
    scene.add(eveningFill);

    const textures = createArchitecturalTextures(renderer.capabilities.getMaxAnisotropy());

    // Camera transition state
    let transitionActive = false;
    const keysPressed: Record<string, boolean> = {};
    let fpsYaw = -0.5;
    let fpsPitch = -0.08;
    let isFpsDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;

    // On-demand / paced render loop
    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let disposed = false;
    let lastPinSync = 0;

    const afterDraw = (cb: () => void) => {
      try {
        const gl = renderer.getContext() as WebGL2RenderingContext;
        if (gl && typeof gl.fenceSync === 'function') {
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
          const poll = () => {
            if (disposed) return;
            const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
            if (state === gl.UNSIGNALED) {
              frameId = window.setTimeout(poll, 5);
            } else {
              if (sync) gl.deleteSync(sync);
              frameId = window.setTimeout(cb, 70);
            }
          };
          frameId = window.setTimeout(poll, 5);
          return;
        }
      } catch {
        // Fallback below
      }
      frameId = window.setTimeout(cb, 80);
    };

    const syncProjectedPins = () => {
      if (!showPinsRef.current || !engineRef.current?.built) {
        return;
      }
      const now = performance.now();
      if (now - lastPinSync < 45) return;
      lastPinSync = now;

      const anchors = engineRef.current.built.pointAnchors;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      if (w <= 0 || h <= 0) return;

      const next: ProjectedPin[] = featuredRef.current.map((pt) => {
        const worldPos = anchors.get(pt.id);
        if (!worldPos) {
          return {
            id: pt.id,
            code: pt.code,
            icon: CATALOG_MAP[pt.itemType]?.icon ?? 'bolt',
            isSelected: pt.id === selectedIdRef.current,
            isHighPower: pt.category === 'Appliances' || pt.itemType === 'socket_16a',
            x: 0,
            y: 0,
            visible: false,
          };
        }
        _projVec.copy(worldPos).project(camera);
        const sx = ((_projVec.x + 1) / 2) * w;
        const sy = ((-_projVec.y + 1) / 2) * h;
        const inView = _projVec.z < 1 && sx > 28 && sx < w - 28 && sy > 24 && sy < h - 24;
        return {
          id: pt.id,
          code: pt.code,
          icon: CATALOG_MAP[pt.itemType]?.icon ?? 'bolt',
          isSelected: pt.id === selectedIdRef.current,
          isHighPower: pt.category === 'Appliances' || pt.itemType === 'socket_16a',
          x: Math.round(sx),
          y: Math.round(sy),
          visible: inView,
        };
      });
      setPins(next);
    };

    const clock = new THREE.Clock();

    const requestRender = () => {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;
        const dt = Math.min(0.05, clock.getDelta());

        // Smooth camera transitions
        if (transitionActive) {
          const factor = isSoftwareGl ? 1 : 1 - Math.exp(-7 * dt);
          camera.position.lerp(_targetCamPos, factor);
          controls.target.lerp(_targetLook, factor);
          if (
            camera.position.distanceTo(_targetCamPos) < 0.05 &&
            controls.target.distanceTo(_targetLook) < 0.05
          ) {
            camera.position.copy(_targetCamPos);
            controls.target.copy(_targetLook);
            transitionActive = false;
          } else {
            renderDirty = true;
          }
        }

        // First-person WASD movement
        if (cameraModeRef.current === 'fps' && !previewOnly) {
          const moveSpeed = 3.2 * dt;
          let moved = false;
          const forward = new THREE.Vector3(-Math.sin(fpsYaw), 0, -Math.cos(fpsYaw));
          const right = new THREE.Vector3(Math.cos(fpsYaw), 0, -Math.sin(fpsYaw));
          if (keysPressed['KeyW'] || keysPressed['ArrowUp']) {
            camera.position.addScaledVector(forward, moveSpeed);
            moved = true;
          }
          if (keysPressed['KeyS'] || keysPressed['ArrowDown']) {
            camera.position.addScaledVector(forward, -moveSpeed);
            moved = true;
          }
          if (keysPressed['KeyA'] || keysPressed['ArrowLeft']) {
            camera.position.addScaledVector(right, -moveSpeed);
            moved = true;
          }
          if (keysPressed['KeyD'] || keysPressed['ArrowRight']) {
            camera.position.addScaledVector(right, moveSpeed);
            moved = true;
          }
          camera.position.y = 1.65;
          camera.rotation.order = 'YXZ';
          camera.rotation.y = fpsYaw;
          camera.rotation.x = fpsPitch;
          if (moved) renderDirty = true;
        } else {
          controls.update();
        }

        // Gentle fan spin on GPU
        if (!isSoftwareGl && engineRef.current?.built) {
          engineRef.current.built.fanRotors.forEach((r) => {
            r.rotation.y += dt * 1.4;
          });
        }

        renderer.render(scene, camera);
        syncProjectedPins();

        const done = () => {
          renderBusy = false;
          if (renderDirty && !disposed) requestRender();
        };

        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    };

    const transitionCamera = (mode: CameraMode, zoomPct: number) => {
      const { lengthM, widthM } = siteToMeters(projectRef.current.site);
      const span = Math.max(lengthM, widthM);
      const zoomScale = 100 / Math.max(55, Math.min(160, zoomPct));

      if (mode === 'fps' && !previewOnly) {
        controls.enabled = false;
        _targetCamPos.set(-lengthM * 0.25, 1.65, widthM * 0.15);
        _targetLook.set(lengthM * 0.2, 1.55, -widthM * 0.15);
        fpsYaw = -0.85;
        fpsPitch = -0.04;
      } else {
        controls.enabled = true;
        const dist = span * 0.92 * zoomScale;
        _targetCamPos.set(dist * 0.72, dist * 0.84, dist * 0.86);
        _targetLook.set(0, 0.55, 0);
      }
      transitionActive = true;
      requestRender();
    };

    const applyLighting = (mode: LightingMode) => {
      if (mode === 'evening') {
        scene.background = new THREE.Color(0x050914);
        scene.fog = new THREE.FogExp2(0x050914, 0.022);
        keyLight.intensity = 0.45;
        keyLight.color.setHex(0x64748b);
        hemiLight.intensity = 0.35;
        rimLight.intensity = 0.55;
        eveningFill.intensity = 2.6;
        renderer.toneMappingExposure = 1.05;
      } else {
        scene.background = new THREE.Color(0x080f20);
        scene.fog = new THREE.FogExp2(0x080f20, 0.016);
        keyLight.intensity = 1.85;
        keyLight.color.setHex(0xfff4e0);
        hemiLight.intensity = 0.95;
        rimLight.intensity = 0.65;
        eveningFill.intensity = 0;
        renderer.toneMappingExposure = 1.15;
      }
    };

    const rebuildScene = () => {
      if (!engineRef.current) return;
      if (engineRef.current.built) {
        scene.remove(engineRef.current.built.root);
        engineRef.current.built.dispose();
        engineRef.current.built = null;
      }
      applyLighting(lightingModeRef.current);
      const built = buildArchitecturalScene(
        projectRef.current,
        textures,
        selectedIdRef.current,
        lightingModeRef.current,
        cameraModeRef.current !== 'fps',
        isSoftwareGl
      );
      scene.add(built.root);
      engineRef.current.built = built;
      requestRender();
    };

    controls.addEventListener('start', () => {
      transitionActive = false;
    });
    controls.addEventListener('change', () => {
      requestRender();
    });

    // Pointer interaction: Raycast click selection / placement / FPS look
    const raycaster = new THREE.Raycaster();
    let pointerDownPos = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      if (cameraModeRef.current === 'fps' && !previewOnly) {
        isFpsDragging = true;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isFpsDragging && cameraModeRef.current === 'fps' && !previewOnly) {
        const dx = e.clientX - lastPointerX;
        const dy = e.clientY - lastPointerY;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        fpsYaw -= dx * 0.004;
        fpsPitch = THREE.MathUtils.clamp(fpsPitch - dy * 0.003, -0.65, 0.55);
        requestRender();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      isFpsDragging = false;
      if (previewOnly) return;
      const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moveDist > 6) return; // Was orbit drag, not click

      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);

      // If placing an electrical item, intersect floor plane
      if (pendingPlaceRef.current && onPlaceRef.current) {
        if (raycaster.ray.intersectPlane(_groundPlane, _planeHit)) {
          const { lengthM, widthM } = siteToMeters(projectRef.current.site);
          const px = THREE.MathUtils.clamp(_planeHit.x + lengthM / 2, 0.3, lengthM - 0.3);
          const py = THREE.MathUtils.clamp(_planeHit.z + widthM / 2, 0.3, widthM - 0.3);
          const room = findRoomAtPoint(projectRef.current.rooms, px, py) ?? projectRef.current.rooms[0];
          if (room) {
            onPlaceRef.current(
              pendingPlaceRef.current,
              Math.round(px * 10) / 10,
              Math.round(py * 10) / 10,
              room.id
            );
          }
        }
        return;
      }

      // Otherwise check clickables
      const clickables = engineRef.current?.built?.clickables ?? [];
      const hits = raycaster.intersectObjects(clickables, true);
      if (hits.length > 0) {
        const pid = hits[0].object.userData?.pointId as string | undefined;
        if (pid && onSelectRef.current) {
          onSelectRef.current(pid);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (cameraModeRef.current !== 'fps' || previewOnly) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        keysPressed[e.code] = true;
        requestRender();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysPressed[e.code] = false;
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // ResizeObserver for crisp container tracking
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(100, Math.floor(entry.contentRect.width));
        const h = Math.max(100, Math.floor(entry.contentRect.height));
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        requestRender();
      }
    });
    resizeObserver.observe(container);

    engineRef.current = {
      scene,
      camera,
      renderer,
      controls,
      textures,
      built: null,
      keyLight,
      hemiLight,
      rimLight,
      eveningFill,
      isSoftwareGl,
      requestRender,
      transitionCamera,
      rebuildScene,
    };

    // Initial build + camera frame
    rebuildScene();
    transitionCamera(cameraModeRef.current, zoom);
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Gentle continuous fan motion on GPU when interactive
    let spinTimer = 0;
    if (!isSoftwareGl) {
      spinTimer = window.setInterval(() => {
        if (!disposed) requestRender();
      }, 33);
    }

    return () => {
      disposed = true;
      if (spinTimer) clearInterval(spinTimer);
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      controls.dispose();
      engineRef.current?.built?.dispose();
      textures.dispose();
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild 3D geometry whenever project, selected node, lighting, or cutaway mode changes
  useEffect(() => {
    engineRef.current?.rebuildScene();
  }, [project, selectedPointId, lightingMode, cameraMode]);

  // Smoothly update camera when cameraMode or zoom changes
  useEffect(() => {
    engineRef.current?.transitionCamera(cameraMode, zoom);
  }, [cameraMode, zoom, project.id]);

  if (webglFailed) {
    return (
      <div className="w-full h-full relative bg-surface">
        <FloorPlan2D
          project={project}
          selectedPointId={selectedPointId}
          previewOnly={previewOnly}
          onSelectPoint={onSelectPoint}
        />
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-hidden bg-surface">
      {/* Dedicated empty mount node for WebGL canvas */}
      <div
        ref={mountRef}
        className={`w-full h-full ${pendingPlaceItem ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      />

      {/* Interactive 3D-projected pin markers (solid dark slate/blue surfaces, zero backdrop-blur) */}
      {showPins && !previewOnly && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {pins.map((pin) =>
            pin.visible ? (
              <button
                key={pin.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPoint?.(pin.id);
                }}
                style={{
                  transform: `translate(${pin.x}px, ${pin.y}px) translate(-50%, -100%)`,
                }}
                className={`pointer-events-auto absolute top-0 left-0 inline-flex items-center gap-gutter-xs px-gutter-sm py-gutter-xs rounded-full font-mono text-mono-sm cursor-pointer transition-colors duration-state-change whitespace-nowrap ${
                  pin.isSelected
                    ? 'bg-primary text-on-primary border-2 border-studio-white z-20'
                    : pin.isHighPower
                      ? 'bg-surface-container text-secondary border border-secondary hover:bg-secondary hover:text-on-secondary z-10'
                      : 'bg-surface-container text-primary border border-primary hover:bg-primary hover:text-on-primary z-10'
                }`}
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  {pin.icon}
                </span>
                <span>{pin.code}</span>
              </button>
            ) : null
          )}
        </div>
      )}

      {/* Subtle First-Person walkthrough hint */}
      {cameraMode === 'fps' && !previewOnly && (
        <div className="pointer-events-none absolute bottom-3 left-3 px-gutter-md py-gutter-xs rounded-sm bg-surface-container border border-outline text-on-surface-variant font-mono text-mono-sm">
          WASD / Arrows to walk · Drag viewport to look around
        </div>
      )}
    </div>
  );
};
