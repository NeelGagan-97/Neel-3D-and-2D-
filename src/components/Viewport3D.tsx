import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CATALOG_MAP, findRoomAtPoint, siteToMeters } from '../data/presets';
import { buildArchitecturalScene, BuiltSceneHandles, STORY_SLAB_THICKNESS } from '../three/architecturalBuilder';
import { ArchitecturalTextureSet, createArchitecturalTextures } from '../three/proceduralTextures';
import {
  CameraMode,
  ElectricalItemType,
  ElectricalPoint,
  FloorView3DMode,
  FurnitureItem,
  LightingMode,
  ProjectData,
} from '../types/design';
import { getItemFloor } from '../utils/geometry';
import { FloorPlan2D } from './FloorPlan2D';

interface Viewport3DProps {
  project: ProjectData;
  activeFloor?: number;
  floorViewMode?: FloorView3DMode;
  selectedPointId?: string | null;
  cameraMode?: CameraMode;
  lightingMode?: LightingMode;
  zoom?: number;
  pendingPlaceItem?: ElectricalItemType | null;
  previewOnly?: boolean;
  showPins?: boolean;
  onSelectPoint?: (pointId: string) => void;
  onPlacePointAt?: (itemType: ElectricalItemType, x: number, y: number, roomId: string) => void;
  onDuplicatePoint?: (pointId: string) => ElectricalPoint | null;
  onMovePoint?: (pointId: string, x: number, y: number, roomId: string) => void;
  onDuplicateFurniture?: (furnitureId: string) => FurnitureItem | null;
  onMoveFurniture?: (furnitureId: string, x: number, y: number, roomId: string) => void;
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
  activeFloor = 1,
  floorViewMode = 'active-only',
  selectedPointId = null,
  cameraMode = 'orbit',
  lightingMode = 'daylight',
  zoom = 100,
  pendingPlaceItem = null,
  previewOnly = false,
  showPins = true,
  onSelectPoint,
  onPlacePointAt,
  onDuplicatePoint,
  onMovePoint,
  onDuplicateFurniture,
  onMoveFurniture,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [pins, setPins] = useState<ProjectedPin[]>([]);

  // Mutable refs so scene callbacks never recreate WebGL context
  const onSelectRef = useRef(onSelectPoint);
  const onPlaceRef = useRef(onPlacePointAt);
  const onDuplicatePointRef = useRef(onDuplicatePoint);
  const onMovePointRef = useRef(onMovePoint);
  const onDuplicateFurnitureRef = useRef(onDuplicateFurniture);
  const onMoveFurnitureRef = useRef(onMoveFurniture);
  const pendingPlaceRef = useRef(pendingPlaceItem);
  const projectRef = useRef(project);
  const activeFloorRef = useRef(activeFloor);
  const floorViewModeRef = useRef<FloorView3DMode>(floorViewMode);
  const selectedIdRef = useRef(selectedPointId);
  const cameraModeRef = useRef(cameraMode);
  const lightingModeRef = useRef(lightingMode);
  const showPinsRef = useRef(showPins && !previewOnly);

  onSelectRef.current = onSelectPoint;
  onPlaceRef.current = onPlacePointAt;
  onDuplicatePointRef.current = onDuplicatePoint;
  onMovePointRef.current = onMovePoint;
  onDuplicateFurnitureRef.current = onDuplicateFurniture;
  onMoveFurnitureRef.current = onMoveFurniture;
  pendingPlaceRef.current = pendingPlaceItem;
  projectRef.current = project;
  activeFloorRef.current = activeFloor;
  floorViewModeRef.current = floorViewMode;
  selectedIdRef.current = selectedPointId;
  cameraModeRef.current = cameraMode;
  lightingModeRef.current = lightingMode;
  showPinsRef.current = showPins && !previewOnly;

  // Visible interactive 3D pins strictly scoped to visible floors
  const featuredPoints = useMemo<ElectricalPoint[]>(() => {
    if (previewOnly || !showPins) return [];
    const pool =
      floorViewMode === 'active-only'
        ? project.points.filter((p) => getItemFloor(p) === activeFloor)
        : floorViewMode === 'up-to-active'
          ? project.points.filter((p) => getItemFloor(p) <= activeFloor)
          : project.points;

    const byPriority: ElectricalPoint[] = [];
    const addIf = (p?: ElectricalPoint) => {
      if (p && !byPriority.some((x) => x.id === p.id)) byPriority.push(p);
    };
    // Always show selected point first if visible on current floors
    if (selectedPointId) {
      addIf(pool.find((p) => p.id === selectedPointId));
    }
    // Include fans, ACs, switchboards, high-power outlets, and other visible fixtures
    pool.filter((p) => p.itemType === 'ceiling_fan').forEach(addIf);
    pool.filter((p) => p.itemType === 'split_ac').forEach(addIf);
    pool.filter((p) => p.itemType === 'switchboard').forEach(addIf);
    pool.filter((p) => p.itemType === 'socket_16a' || p.itemType === 'geyser').forEach(addIf);
    pool.forEach(addIf);
    return byPriority.slice(0, 16);
  }, [project.points, activeFloor, floorViewMode, selectedPointId, previewOnly, showPins]);

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
    beginDragFromPin: (pointId: string, floorNum: number, clientX: number, clientY: number) => void;
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

        // First-person WASD movement on active floor elevation
        if (cameraModeRef.current === 'fps' && !previewOnly) {
          const { ceilingM } = siteToMeters(projectRef.current.site);
          const floorBaseY = Math.max(0, (activeFloorRef.current - 1) * (ceilingM + STORY_SLAB_THICKNESS));
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
          camera.position.y = floorBaseY + 1.65;
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
      const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
      const totalFloors = Math.max(1, Math.min(5, Math.round(projectRef.current.site.floors || 1)));
      const activeFl = Math.max(1, Math.min(totalFloors, Math.round(activeFloorRef.current || 1)));
      const storyStep = ceilingM + STORY_SLAB_THICKNESS;
      const floorBaseY = (activeFl - 1) * storyStep;

      const visibleTopFloor =
        floorViewModeRef.current === 'all' ? totalFloors : activeFl;
      const visibleBotFloor =
        floorViewModeRef.current === 'active-only' ? activeFl : 1;
      const totalStackH = (visibleTopFloor - visibleBotFloor + 1) * storyStep;
      const midY = (visibleBotFloor - 1) * storyStep + totalStackH * 0.42;

      const span = Math.max(lengthM, widthM, totalStackH * 1.15);
      const zoomScale = 100 / Math.max(55, Math.min(160, zoomPct));

      if (mode === 'fps' && !previewOnly) {
        controls.enabled = false;
        _targetCamPos.set(-lengthM * 0.25, floorBaseY + 1.65, widthM * 0.15);
        _targetLook.set(lengthM * 0.2, floorBaseY + 1.55, -widthM * 0.15);
        fpsYaw = -0.85;
        fpsPitch = -0.04;
      } else {
        controls.enabled = true;
        const dist = span * 0.94 * zoomScale;
        _targetCamPos.set(dist * 0.72, midY + dist * 0.76, dist * 0.88);
        _targetLook.set(0, midY, 0);
      }
      transitionActive = true;
      requestRender();
    };

    const applyLighting = (mode: LightingMode) => {
      if (mode === 'evening') {
        scene.background = new THREE.Color(0x050914);
        scene.fog = new THREE.FogExp2(0x050914, 0.018);
        keyLight.intensity = 0.45;
        keyLight.color.setHex(0x64748b);
        hemiLight.intensity = 0.35;
        rimLight.intensity = 0.55;
        eveningFill.intensity = 2.6;
        renderer.toneMappingExposure = 1.05;
      } else {
        scene.background = new THREE.Color(0x080f20);
        scene.fog = new THREE.FogExp2(0x080f20, 0.012);
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

      // Align ground CAD grid directly under the lowest visible floor
      const { ceilingM } = siteToMeters(projectRef.current.site);
      const totalFloors = Math.max(1, Math.min(5, Math.round(projectRef.current.site.floors || 1)));
      const clampedFl = Math.max(1, Math.min(totalFloors, Math.round(activeFloorRef.current || 1)));
      const storyStep = ceilingM + STORY_SLAB_THICKNESS;
      const lowestBaseY =
        floorViewModeRef.current === 'active-only' ? (clampedFl - 1) * storyStep : 0;
      grid.position.y = lowestBaseY - 0.25;

      const built = buildArchitecturalScene(
        projectRef.current,
        textures,
        selectedIdRef.current,
        lightingModeRef.current,
        cameraModeRef.current !== 'fps',
        isSoftwareGl,
        activeFloorRef.current,
        floorViewModeRef.current
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

    // Pointer interaction: Raycast click selection, Ctrl+Click duplicate, free 3D drag, placement & FPS look
    const raycaster = new THREE.Raycaster();
    let pointerDownPos = { x: 0, y: 0 };
    let active3DDrag: {
      kind: 'point' | 'furniture';
      id: string;
      floorNum: number;
      startX: number;
      startY: number;
      moved: boolean;
      lastMoveTs: number;
    } | null = null;

    const projectClientToFloorMeters = (clientX: number, clientY: number, floorNum: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);
      const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
      const floorBaseY = Math.max(0, (floorNum - 1) * (ceilingM + STORY_SLAB_THICKNESS));
      _groundPlane.constant = -floorBaseY;
      if (!raycaster.ray.intersectPlane(_groundPlane, _planeHit)) return null;
      const px = THREE.MathUtils.clamp(_planeHit.x + lengthM / 2, 0.2, lengthM - 0.2);
      const py = THREE.MathUtils.clamp(_planeHit.z + widthM / 2, 0.2, widthM - 0.2);
      const floorRooms = projectRef.current.rooms.filter((r) => getItemFloor(r) === floorNum);
      const room = findRoomAtPoint(floorRooms, px, py) ?? floorRooms[0];
      return {
        x: Math.round(px * 20) / 20,
        y: Math.round(py * 20) / 20,
        roomId: room?.id ?? '',
      };
    };

    const beginDragFromPin = (pointId: string, floorNum: number, clientX: number, clientY: number) => {
      if (previewOnly || cameraModeRef.current === 'fps') return;
      active3DDrag = {
        kind: 'point',
        id: pointId,
        floorNum,
        startX: clientX,
        startY: clientY,
        moved: false,
        lastMoveTs: 0,
      };
      controls.enabled = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      if (cameraModeRef.current === 'fps' && !previewOnly) {
        isFpsDragging = true;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        return;
      }

      if (previewOnly || e.button !== 0 || pendingPlaceRef.current) return;

      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);

      const clickables = engineRef.current?.built?.clickables ?? [];
      const hits = raycaster.intersectObjects(clickables, true);
      if (hits.length === 0) return;

      const hitObj = hits[0].object;
      const pid = hitObj.userData?.pointId as string | undefined;
      const fid = hitObj.userData?.furnitureId as string | undefined;

      // Ctrl + Left Click on any 3D electrical fixture (fan, light, AC, switch, socket) -> Duplicate & drag freely!
      if ((e.ctrlKey || e.metaKey) && pid && onDuplicatePointRef.current) {
        e.stopPropagation();
        e.preventDefault();
        const dup = onDuplicatePointRef.current(pid);
        if (dup) {
          active3DDrag = {
            kind: 'point',
            id: dup.id,
            floorNum: getItemFloor(dup),
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            lastMoveTs: 0,
          };
          controls.enabled = false;
        }
        return;
      }

      // Ctrl + Left Click on any 3D furniture item (sofa, bed, table, desk) -> Duplicate & drag freely!
      if ((e.ctrlKey || e.metaKey) && fid && onDuplicateFurnitureRef.current) {
        e.stopPropagation();
        e.preventDefault();
        const dup = onDuplicateFurnitureRef.current(fid);
        if (dup) {
          active3DDrag = {
            kind: 'furniture',
            id: dup.id,
            floorNum: getItemFloor(dup),
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            lastMoveTs: 0,
          };
          controls.enabled = false;
        }
        return;
      }

      // Direct drag on the currently selected 3D electrical fixture to reposition freely
      if (!e.ctrlKey && !e.metaKey && pid && pid === selectedIdRef.current && onMovePointRef.current) {
        const pt = projectRef.current.points.find((p) => p.id === pid);
        if (pt) {
          e.stopPropagation();
          active3DDrag = {
            kind: 'point',
            id: pt.id,
            floorNum: getItemFloor(pt),
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            lastMoveTs: 0,
          };
          controls.enabled = false;
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (active3DDrag) {
        const dist = Math.hypot(e.clientX - active3DDrag.startX, e.clientY - active3DDrag.startY);
        if (!active3DDrag.moved && dist < 5) return;
        active3DDrag.moved = true;
        const now = performance.now();
        if (now - active3DDrag.lastMoveTs < 28) return;
        active3DDrag.lastMoveTs = now;

        const target = projectClientToFloorMeters(e.clientX, e.clientY, active3DDrag.floorNum);
        if (!target) return;
        if (active3DDrag.kind === 'point') {
          onMovePointRef.current?.(active3DDrag.id, target.x, target.y, target.roomId);
        } else {
          onMoveFurnitureRef.current?.(active3DDrag.id, target.x, target.y, target.roomId);
        }
        return;
      }

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

    const onWindowPointerUp = () => {
      if (active3DDrag) {
        active3DDrag = null;
        if (cameraModeRef.current !== 'fps') {
          controls.enabled = true;
        }
      }
      isFpsDragging = false;
    };

    const onPointerUp = (e: PointerEvent) => {
      isFpsDragging = false;
      if (active3DDrag) {
        active3DDrag = null;
        if (cameraModeRef.current !== 'fps') {
          controls.enabled = true;
        }
        return;
      }
      if (previewOnly) return;
      const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moveDist > 6) return; // Was orbit drag, not click

      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);

      // If placing an electrical item, intersect active floor plane
      if (pendingPlaceRef.current && onPlaceRef.current) {
        const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
        const floorBaseY = Math.max(0, (activeFloorRef.current - 1) * (ceilingM + STORY_SLAB_THICKNESS));
        _groundPlane.constant = -floorBaseY;
        if (raycaster.ray.intersectPlane(_groundPlane, _planeHit)) {
          const px = THREE.MathUtils.clamp(_planeHit.x + lengthM / 2, 0.3, lengthM - 0.3);
          const py = THREE.MathUtils.clamp(_planeHit.z + widthM / 2, 0.3, widthM - 0.3);
          const floorRooms = projectRef.current.rooms.filter(
            (r) => getItemFloor(r) === activeFloorRef.current
          );
          const room = findRoomAtPoint(floorRooms, px, py) ?? floorRooms[0];
          onPlaceRef.current(
            pendingPlaceRef.current,
            Math.round(px * 10) / 10,
            Math.round(py * 10) / 10,
            room?.id ?? ''
          );
        }
        return;
      }

      // Otherwise check clickables for standard selection
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

    // Capture phase so Ctrl+Click duplicate / selected-item drag takes priority over OrbitControls
    renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
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
      beginDragFromPin,
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
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
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

  // Rebuild 3D geometry whenever project, selected node, lighting, floor, or cutaway mode changes
  useEffect(() => {
    engineRef.current?.rebuildScene();
  }, [project, selectedPointId, lightingMode, cameraMode, activeFloor, floorViewMode]);

  // Smoothly update camera when cameraMode, zoom, floors count, or active floor view changes
  useEffect(() => {
    engineRef.current?.transitionCamera(cameraMode, zoom);
  }, [cameraMode, zoom, project.id, project.site.floors, activeFloor, floorViewMode]);

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
                title="Click to select · Drag to move · Ctrl + Click to duplicate"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const dup = onDuplicatePoint?.(pin.id);
                    if (dup) {
                      engineRef.current?.beginDragFromPin(
                        dup.id,
                        getItemFloor(dup),
                        e.clientX,
                        e.clientY
                      );
                    }
                    return;
                  }
                  onSelectPoint?.(pin.id);
                  const pt = project.points.find((p) => p.id === pin.id);
                  if (pt) {
                    engineRef.current?.beginDragFromPin(
                      pt.id,
                      getItemFloor(pt),
                      e.clientX,
                      e.clientY
                    );
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                style={{
                  transform: `translate(${pin.x}px, ${pin.y}px) translate(-50%, -100%)`,
                }}
                className={`pointer-events-auto absolute top-0 left-0 inline-flex items-center gap-gutter-xs px-gutter-sm py-gutter-xs rounded-full font-mono text-mono-sm cursor-pointer transition-colors duration-state-change whitespace-nowrap select-none ${
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

      {/* Subtle 3D interaction hint */}
      {!previewOnly && (
        <div className="pointer-events-none absolute bottom-3 left-3 px-gutter-md py-gutter-xs rounded-sm bg-surface-container border border-outline text-on-surface-variant font-mono text-mono-sm">
          {cameraMode === 'fps'
            ? 'WASD / Arrows to walk · Drag viewport to look around'
            : 'Ctrl + Left Click any fan, fixture or furniture to duplicate · Drag pin or selected item to reposition'}
        </div>
      )}
    </div>
  );
};
