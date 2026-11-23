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
  SelectedEntity,
  StudioEntityRef,
  StudioFocusTarget,
} from '../types/design';
import { getItemFloor } from '../utils/geometry';
import {
  isEditableEventTarget,
  resolve3DWalkDirection,
  resolve3DWalkDirectionFromCode,
  WalkDirection,
} from '../utils/studioEditor';
import { FloorPlan2D } from './FloorPlan2D';

interface Viewport3DProps {
  project: ProjectData;
  activeFloor?: number;
  floorViewMode?: FloorView3DMode;
  selectedPointId?: string | null;
  selectedEntities?: StudioEntityRef[];
  highlightedIds?: Set<string>;
  activeHighlightId?: string | null;
  focusTarget?: StudioFocusTarget | null;
  cameraMode?: CameraMode;
  lightingMode?: LightingMode;
  zoom?: number;
  pendingPlaceItem?: ElectricalItemType | null;
  previewOnly?: boolean;
  showPins?: boolean;
  onSelectEntity?: (entity: SelectedEntity, additive?: boolean) => void;
  onSelectPoint?: (pointId: string, additive?: boolean) => void;
  onPlacePointAt?: (itemType: ElectricalItemType, x: number, y: number, roomId: string) => void;
  onDuplicatePoint?: (pointId: string) => ElectricalPoint | null;
  onMovePoint?: (pointId: string, x: number, y: number, roomId: string) => void;
  onDuplicateFurniture?: (furnitureId: string) => FurnitureItem | null;
  onMoveFurniture?: (furnitureId: string, x: number, y: number, roomId: string) => void;
  onRecordHistorySnapshot?: () => void;
  onCanvasContextMenu?: (pos: { x: number; y: number }) => void;
}

interface ProjectedPin {
  id: string;
  code: string;
  icon: string;
  isSelected: boolean;
  isHighlighted: boolean;
  isActiveHighlight: boolean;
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
const _fpsForward = new THREE.Vector3();
const _fpsRight = new THREE.Vector3();

// 1:3 architectural preview enlargement ratio (1 unit drawn in 2D = 3 units in interactive 3D Preview)
export const PREVIEW_3D_SCALE = 3;

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
  selectedEntities = [],
  highlightedIds,
  activeHighlightId = null,
  focusTarget = null,
  cameraMode = 'orbit',
  lightingMode = 'daylight',
  zoom = 100,
  pendingPlaceItem = null,
  previewOnly = false,
  showPins = true,
  onSelectEntity,
  onSelectPoint,
  onPlacePointAt,
  onDuplicatePoint,
  onMovePoint,
  onDuplicateFurniture,
  onMoveFurniture,
  onRecordHistorySnapshot,
  onCanvasContextMenu,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [pins, setPins] = useState<ProjectedPin[]>([]);

  const selectedIds = useMemo(() => {
    const set = new Set<string>();
    if (selectedPointId) set.add(selectedPointId);
    selectedEntities.forEach((e) => set.add(e.id));
    return set;
  }, [selectedPointId, selectedEntities]);

  // Mutable refs so scene callbacks never recreate WebGL context
  const onSelectEntityRef = useRef(onSelectEntity);
  const onSelectRef = useRef(onSelectPoint);
  const onPlaceRef = useRef(onPlacePointAt);
  const onDuplicatePointRef = useRef(onDuplicatePoint);
  const onMovePointRef = useRef(onMovePoint);
  const onDuplicateFurnitureRef = useRef(onDuplicateFurniture);
  const onMoveFurnitureRef = useRef(onMoveFurniture);
  const onRecordHistorySnapshotRef = useRef(onRecordHistorySnapshot);
  const onCanvasContextMenuRef = useRef(onCanvasContextMenu);
  const pendingPlaceRef = useRef(pendingPlaceItem);
  const projectRef = useRef(project);
  const activeFloorRef = useRef(activeFloor);
  const floorViewModeRef = useRef<FloorView3DMode>(floorViewMode);
  const selectedIdRef = useRef(selectedPointId);
  const selectedIdsRef = useRef(selectedIds);
  const highlightedIdsRef = useRef(highlightedIds);
  const activeHighlightIdRef = useRef(activeHighlightId);
  const cameraModeRef = useRef(cameraMode);
  const lightingModeRef = useRef(lightingMode);
  const showPinsRef = useRef(showPins && !previewOnly);

  onSelectEntityRef.current = onSelectEntity;
  onSelectRef.current = onSelectPoint;
  onPlaceRef.current = onPlacePointAt;
  onDuplicatePointRef.current = onDuplicatePoint;
  onMovePointRef.current = onMovePoint;
  onDuplicateFurnitureRef.current = onDuplicateFurniture;
  onMoveFurnitureRef.current = onMoveFurniture;
  onRecordHistorySnapshotRef.current = onRecordHistorySnapshot;
  onCanvasContextMenuRef.current = onCanvasContextMenu;
  pendingPlaceRef.current = pendingPlaceItem;
  projectRef.current = project;
  activeFloorRef.current = activeFloor;
  floorViewModeRef.current = floorViewMode;
  selectedIdRef.current = selectedPointId;
  selectedIdsRef.current = selectedIds;
  highlightedIdsRef.current = highlightedIds;
  activeHighlightIdRef.current = activeHighlightId;
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
    // Always show active search match, highlighted search results, and selected points first
    if (activeHighlightId) {
      addIf(pool.find((p) => p.id === activeHighlightId));
    }
    if (highlightedIds && highlightedIds.size > 0) {
      pool.filter((p) => highlightedIds.has(p.id)).forEach(addIf);
    }
    pool.filter((p) => selectedIds.has(p.id)).forEach(addIf);
    // Include fans, ACs, switchboards, high-power outlets, and other visible fixtures
    pool.filter((p) => p.itemType === 'ceiling_fan').forEach(addIf);
    pool.filter((p) => p.itemType === 'split_ac').forEach(addIf);
    pool.filter((p) => p.itemType === 'switchboard').forEach(addIf);
    pool.filter((p) => p.itemType === 'socket_16a' || p.itemType === 'geyser').forEach(addIf);
    pool.forEach(addIf);
    return byPriority.slice(0, 20);
  }, [
    project.points,
    activeFloor,
    floorViewMode,
    selectedIds,
    highlightedIds,
    activeHighlightId,
    previewOnly,
    showPins,
  ]);

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
    focusOnTarget: (target: StudioFocusTarget) => void;
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

    // 1:3 enlarged ratio in interactive 3D Preview (Home page card preview stays 1:1)
    const sceneScale = previewOnly ? 1 : PREVIEW_3D_SCALE;

    // Scene + Fog + RoomEnvironment Studio Reflections
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080f20);
    scene.fog = new THREE.FogExp2(0x080f20, 0.012 / sceneScale);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    // Camera (enlarged FOV & extended clip range for 1:3 interactive 3D Preview)
    const camera = new THREE.PerspectiveCamera(
      previewOnly ? 38 : 48,
      width / height,
      0.15,
      160 * sceneScale
    );
    camera.position.set(11.5 * sceneScale, 11.2 * sceneScale, 13.0 * sceneScale);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = previewOnly ? 4 : 3.2;
    controls.maxDistance = 42 * sceneScale;
    controls.enablePan = !previewOnly;
    controls.target.set(0, 0.6 * sceneScale, 0);
    controls.update();

    // CAD Ground Grid scaled 1:3 so each cell equals 1m of the 2D drawing
    const grid = new THREE.GridHelper(44 * sceneScale, 44, 0x00a8ff, 0x1d2b44);
    grid.position.y = -0.25 * sceneScale;
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

    // 3-Point Warm/Cool Studio Architectural Lighting Rig scaled to match 1:3 scene bounds
    const hemiLight = new THREE.HemisphereLight(0xcbe8ff, 0x1e293b, 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e0, 1.85);
    keyLight.position.set(14 * sceneScale, 22 * sceneScale, 12 * sceneScale);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.left = -14 * sceneScale;
      keyLight.shadow.camera.right = 14 * sceneScale;
      keyLight.shadow.camera.top = 14 * sceneScale;
      keyLight.shadow.camera.bottom = -14 * sceneScale;
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 90 * sceneScale;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02 * sceneScale;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.65);
    rimLight.position.set(-14 * sceneScale, 10 * sceneScale, -12 * sceneScale);
    scene.add(rimLight);

    // Warm interior ambiance light for Evening mode
    const eveningFill = new THREE.PointLight(0xffb454, 0, 22 * sceneScale, 1.4);
    eveningFill.position.set(0, 3.2 * sceneScale, 0);
    scene.add(eveningFill);

    const textures = createArchitecturalTextures(renderer.capabilities.getMaxAnisotropy());

    // Camera transition state
    let transitionActive = false;
    const walkKeys: Record<WalkDirection, boolean> = {
      forward: false,
      backward: false,
      left: false,
      right: false,
    };
    const clearWalkKeys = () => {
      walkKeys.forward = false;
      walkKeys.backward = false;
      walkKeys.left = false;
      walkKeys.right = false;
    };
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
        const isSel = selectedIdsRef.current.has(pt.id) || pt.id === selectedIdRef.current;
        const isHl = !!highlightedIdsRef.current?.has(pt.id);
        const isActHl = activeHighlightIdRef.current === pt.id;
        if (!worldPos) {
          return {
            id: pt.id,
            code: pt.code,
            icon: CATALOG_MAP[pt.itemType]?.icon ?? 'bolt',
            isSelected: isSel,
            isHighlighted: isHl,
            isActiveHighlight: isActHl,
            isHighPower: pt.category === 'Appliances' || pt.itemType === 'socket_16a',
            x: 0,
            y: 0,
            visible: false,
          };
        }
        _projVec.copy(worldPos).multiplyScalar(sceneScale).project(camera);
        const sx = ((_projVec.x + 1) / 2) * w;
        const sy = ((-_projVec.y + 1) / 2) * h;
        const inView = _projVec.z < 1 && sx > 28 && sx < w - 28 && sy > 24 && sy < h - 24;
        return {
          id: pt.id,
          code: pt.code,
          icon: CATALOG_MAP[pt.itemType]?.icon ?? 'bolt',
          isSelected: isSel,
          isHighlighted: isHl,
          isActiveHighlight: isActHl,
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

        // First-person W/A/S/D (uppercase or lowercase) & Arrow movement on 1:3 enlarged active floor
        if (cameraModeRef.current === 'fps' && !previewOnly) {
          const { ceilingM } = siteToMeters(projectRef.current.site);
          const floorBaseY = Math.max(0, (activeFloorRef.current - 1) * (ceilingM + STORY_SLAB_THICKNESS));
          const moveSpeed = 2.6 * sceneScale * dt;
          let moved = false;
          _fpsForward.set(-Math.sin(fpsYaw), 0, -Math.cos(fpsYaw));
          _fpsRight.set(Math.cos(fpsYaw), 0, -Math.sin(fpsYaw));
          if (walkKeys.forward) {
            camera.position.addScaledVector(_fpsForward, moveSpeed);
            moved = true;
          }
          if (walkKeys.backward) {
            camera.position.addScaledVector(_fpsForward, -moveSpeed);
            moved = true;
          }
          if (walkKeys.left) {
            camera.position.addScaledVector(_fpsRight, -moveSpeed);
            moved = true;
          }
          if (walkKeys.right) {
            camera.position.addScaledVector(_fpsRight, moveSpeed);
            moved = true;
          }
          if (moved) {
            transitionActive = false;
            renderDirty = true;
          }
          // Slightly lower eye height relative to 3x walls/ceilings so rooms feel grand & spacious
          camera.position.y = (floorBaseY + 1.48) * sceneScale;
          camera.rotation.order = 'YXZ';
          camera.rotation.y = fpsYaw;
          camera.rotation.x = fpsPitch;
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
        clearWalkKeys();
        controls.enabled = false;
        _targetCamPos.set(
          -lengthM * 0.25 * sceneScale,
          (floorBaseY + 1.48) * sceneScale,
          widthM * 0.15 * sceneScale
        );
        _targetLook.set(
          lengthM * 0.2 * sceneScale,
          (floorBaseY + 1.42) * sceneScale,
          -widthM * 0.15 * sceneScale
        );
        fpsYaw = -0.85;
        fpsPitch = -0.04;
      } else {
        clearWalkKeys();
        controls.enabled = true;
        // Closer framing multiplier in 1:3 Preview so switching from 2D to 3D immediately feels enlarged
        const distFactor = previewOnly ? 0.94 : 0.62;
        const dist = span * sceneScale * distFactor * zoomScale;
        _targetCamPos.set(dist * 0.72, midY * sceneScale + dist * 0.72, dist * 0.86);
        _targetLook.set(0, midY * sceneScale, 0);
      }
      transitionActive = true;
      requestRender();
    };

    const focusOnTarget = (target: StudioFocusTarget) => {
      if (previewOnly || cameraModeRef.current === 'fps') return;
      const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
      const storyStep = ceilingM + STORY_SLAB_THICKNESS;
      const floorBaseY = Math.max(0, (target.floor - 1) * storyStep);
      const wx = (target.x - lengthM / 2) * sceneScale;
      const wz = (target.y - widthM / 2) * sceneScale;
      const wy = (floorBaseY + Math.min(ceilingM - 0.2, Math.max(0.5, target.z ?? 1.1))) * sceneScale;
      controls.enabled = true;
      _targetLook.set(wx, wy, wz);
      _targetCamPos.set(wx + 3.2 * sceneScale, wy + 3.4 * sceneScale, wz + 3.6 * sceneScale);
      transitionActive = true;
      requestRender();
    };

    const applyLighting = (mode: LightingMode) => {
      if (mode === 'evening') {
        scene.background = new THREE.Color(0x050914);
        scene.fog = new THREE.FogExp2(0x050914, 0.014 / sceneScale);
        keyLight.intensity = 0.45;
        keyLight.color.setHex(0x64748b);
        hemiLight.intensity = 0.35;
        rimLight.intensity = 0.55;
        eveningFill.intensity = 2.6;
        renderer.toneMappingExposure = 1.05;
      } else {
        scene.background = new THREE.Color(0x080f20);
        scene.fog = new THREE.FogExp2(0x080f20, 0.01 / sceneScale);
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

      // Align ground CAD grid directly under the lowest visible floor (scaled 1:3)
      const { ceilingM } = siteToMeters(projectRef.current.site);
      const totalFloors = Math.max(1, Math.min(5, Math.round(projectRef.current.site.floors || 1)));
      const clampedFl = Math.max(1, Math.min(totalFloors, Math.round(activeFloorRef.current || 1)));
      const storyStep = ceilingM + STORY_SLAB_THICKNESS;
      const lowestBaseY =
        floorViewModeRef.current === 'active-only' ? (clampedFl - 1) * storyStep : 0;
      grid.position.y = (lowestBaseY - 0.25) * sceneScale;

      const built = buildArchitecturalScene(
        projectRef.current,
        textures,
        selectedIdRef.current,
        lightingModeRef.current,
        cameraModeRef.current !== 'fps',
        isSoftwareGl,
        activeFloorRef.current,
        floorViewModeRef.current,
        {
          selectedIds: selectedIdsRef.current,
          highlightedIds: highlightedIdsRef.current,
          activeHighlightId: activeHighlightIdRef.current,
        }
      );
      built.root.scale.setScalar(sceneScale);
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
    let rightDownPos: { x: number; y: number } | null = null;
    let active3DDrag: {
      kind: 'point' | 'furniture';
      id: string;
      floorNum: number;
      startX: number;
      startY: number;
      moved: boolean;
      snapshotRecorded: boolean;
      lastMoveTs: number;
    } | null = null;

    const projectClientToFloorMeters = (clientX: number, clientY: number, floorNum: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_rayMouse, camera);
      const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
      const floorBaseY = Math.max(0, (floorNum - 1) * (ceilingM + STORY_SLAB_THICKNESS));
      _groundPlane.constant = -(floorBaseY * sceneScale);
      if (!raycaster.ray.intersectPlane(_groundPlane, _planeHit)) return null;
      const px = THREE.MathUtils.clamp(_planeHit.x / sceneScale + lengthM / 2, 0.2, lengthM - 0.2);
      const py = THREE.MathUtils.clamp(_planeHit.z / sceneScale + widthM / 2, 0.2, widthM - 0.2);
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
        snapshotRecorded: false,
        lastMoveTs: 0,
      };
      controls.enabled = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      if (e.button === 2) {
        rightDownPos = { x: e.clientX, y: e.clientY };
        return;
      }
      if (cameraModeRef.current === 'fps' && !previewOnly) {
        if (e.button === 0) {
          isFpsDragging = true;
          lastPointerX = e.clientX;
          lastPointerY = e.clientY;
        }
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
            snapshotRecorded: true, // duplicate already recorded history
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
            snapshotRecorded: true, // duplicate already recorded history
            lastMoveTs: 0,
          };
          controls.enabled = false;
        }
        return;
      }

      // Direct drag on any currently selected 3D electrical fixture to reposition freely
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        pid &&
        selectedIdsRef.current.has(pid) &&
        onMovePointRef.current
      ) {
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
            snapshotRecorded: false,
            lastMoveTs: 0,
          };
          controls.enabled = false;
        }
        return;
      }

      // Direct drag on any currently selected 3D furniture item to reposition freely
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        fid &&
        selectedIdsRef.current.has(fid) &&
        onMoveFurnitureRef.current
      ) {
        const fn = projectRef.current.furniture.find((f) => f.id === fid);
        if (fn) {
          e.stopPropagation();
          active3DDrag = {
            kind: 'furniture',
            id: fn.id,
            floorNum: getItemFloor(fn),
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            snapshotRecorded: false,
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
        if (!active3DDrag.snapshotRecorded) {
          active3DDrag.snapshotRecorded = true;
          onRecordHistorySnapshotRef.current?.();
        }
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

      // If placing an electrical item, intersect active floor plane (scaled 1:3)
      if (pendingPlaceRef.current && onPlaceRef.current) {
        const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
        const floorBaseY = Math.max(0, (activeFloorRef.current - 1) * (ceilingM + STORY_SLAB_THICKNESS));
        _groundPlane.constant = -(floorBaseY * sceneScale);
        if (raycaster.ray.intersectPlane(_groundPlane, _planeHit)) {
          const px = THREE.MathUtils.clamp(_planeHit.x / sceneScale + lengthM / 2, 0.3, lengthM - 0.3);
          const py = THREE.MathUtils.clamp(_planeHit.z / sceneScale + widthM / 2, 0.3, widthM - 0.3);
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

      // Otherwise check clickables for standard or Shift-additive selection (points & furniture)
      const clickables = engineRef.current?.built?.clickables ?? [];
      const hits = raycaster.intersectObjects(clickables, true);
      if (hits.length > 0) {
        const pid = hits[0].object.userData?.pointId as string | undefined;
        const fid = hits[0].object.userData?.furnitureId as string | undefined;
        if (pid) {
          if (onSelectEntityRef.current) {
            onSelectEntityRef.current({ kind: 'point', id: pid }, e.shiftKey);
          } else {
            onSelectRef.current?.(pid, e.shiftKey);
          }
          return;
        }
        if (fid && onSelectEntityRef.current) {
          onSelectEntityRef.current({ kind: 'furniture', id: fid }, e.shiftKey);
          return;
        }
      } else if (!e.shiftKey && onSelectEntityRef.current) {
        onSelectEntityRef.current(null);
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (previewOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const moveDist = rightDownPos
        ? Math.hypot(e.clientX - rightDownPos.x, e.clientY - rightDownPos.y)
        : 0;
      rightDownPos = null;
      if (moveDist < 6) {
        onCanvasContextMenuRef.current?.({ x: e.clientX, y: e.clientY });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (cameraModeRef.current !== 'fps' || previewOnly) return;
      if (isEditableEventTarget(e.target)) return;
      const dir = resolve3DWalkDirection(e);
      if (dir) {
        e.preventDefault();
        walkKeys[dir] = true;
        requestRender();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = resolve3DWalkDirectionFromCode(e.code);
      if (dir) {
        walkKeys[dir] = false;
      }
    };
    const onWindowBlur = () => {
      clearWalkKeys();
      isFpsDragging = false;
    };

    // Capture phase so Ctrl+Click duplicate / selected-item drag takes priority over OrbitControls
    renderer.domElement.addEventListener('pointerdown', onPointerDown, true);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

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
      focusOnTarget,
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
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
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

  // Rebuild 3D geometry whenever project, selection, highlights, lighting, floor, or cutaway mode changes
  useEffect(() => {
    engineRef.current?.rebuildScene();
  }, [
    project,
    selectedPointId,
    selectedIds,
    highlightedIds,
    activeHighlightId,
    lightingMode,
    cameraMode,
    activeFloor,
    floorViewMode,
  ]);

  // Smoothly update camera when cameraMode, zoom, floors count, or active floor view changes
  useEffect(() => {
    engineRef.current?.transitionCamera(cameraMode, zoom);
  }, [cameraMode, zoom, project.id, project.site.floors, activeFloor, floorViewMode]);

  // Smoothly frame camera onto searched/navigated component from Find Component (Ctrl+F)
  useEffect(() => {
    if (!focusTarget) return;
    engineRef.current?.focusOnTarget(focusTarget);
  }, [focusTarget]);

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
                  if (onSelectEntity) {
                    onSelectEntity({ kind: 'point', id: pin.id }, e.shiftKey);
                  } else {
                    onSelectPoint?.(pin.id, e.shiftKey);
                  }
                  if (!e.shiftKey) {
                    const pt = project.points.find((p) => p.id === pin.id);
                    if (pt) {
                      engineRef.current?.beginDragFromPin(
                        pt.id,
                        getItemFloor(pt),
                        e.clientX,
                        e.clientY
                      );
                    }
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                style={{
                  transform: `translate(${pin.x}px, ${pin.y}px) translate(-50%, -100%)`,
                }}
                className={`pointer-events-auto absolute top-0 left-0 inline-flex items-center gap-gutter-xs px-gutter-sm py-gutter-xs rounded-full font-mono text-mono-sm cursor-pointer transition-colors duration-state-change whitespace-nowrap select-none ${
                  pin.isActiveHighlight
                    ? 'bg-secondary text-on-secondary border-2 border-studio-white z-30 shadow-lg'
                    : pin.isSelected
                      ? 'bg-primary text-on-primary border-2 border-studio-white z-20'
                      : pin.isHighlighted
                        ? 'bg-surface-container text-secondary border-2 border-secondary z-20'
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
            ? 'Walk Mode (1:3 Scale): W / A / S / D or Arrows to navigate · Drag to look · Press E or Esc to exit'
            : '3D Scale 1:3 · Press E to enter 3D Walk · Right-click canvas for options · Ctrl + Click to duplicate'}
        </div>
      )}
    </div>
  );
};
