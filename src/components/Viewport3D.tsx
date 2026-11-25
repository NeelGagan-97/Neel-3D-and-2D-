import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CATALOG_MAP, findRoomAtPoint, siteToMeters } from '../data/presets';
import {
  buildArchitecturalScene,
  BuiltSceneHandles,
  EXPLODED_FLOOR_GAP_M,
  STORY_SLAB_THICKNESS,
} from '../three/architecturalBuilder';
import { ArchitecturalTextureSet, createArchitecturalTextures } from '../three/proceduralTextures';
import { createSkyAtmosphere, SkyAtmosphereHandles } from '../three/skyAtmosphere';
import {
  CameraMode,
  CameraPreset,
  ElectricalItemType,
  ElectricalPoint,
  FloorView3DMode,
  FurnitureItem,
  LightingMode,
  ProjectData,
  SavedCameraView,
  SelectedEntity,
  StudioEntityRef,
  StudioFocusTarget,
} from '../types/design';
import { getFloorElevationM, getProjectFloors } from '../utils/buildingWiring';
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
  cameraPreset?: CameraPreset;
  savedCameraView?: SavedCameraView | null;
  onCameraCaptureReady?: (captureFn: () => SavedCameraView | null) => void;
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
  onSwitchTo2D?: () => void;
}

interface Viewport3DFailure {
  stage: string;
  message: string;
  recoverable: boolean;
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
const _sceneBox = new THREE.Box3();
const _sceneCenter = new THREE.Vector3();
const _sceneSize = new THREE.Vector3();

// 1:3 architectural preview enlargement ratio (1 unit drawn in 2D = 3 units in interactive 3D Preview)
export const PREVIEW_3D_SCALE = 3;

function formatViewportError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Unexpected WebGL or Three.js error.';
}

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

function isOrthographicPreset(preset: CameraPreset): boolean {
  return (
    preset === 'top' ||
    preset === 'front' ||
    preset === 'rear' ||
    preset === 'left' ||
    preset === 'right' ||
    preset === 'isometric'
  );
}

const Viewport3DInner: React.FC<Viewport3DProps> = ({
  project,
  activeFloor = 1,
  floorViewMode = 'active-only',
  selectedPointId = null,
  selectedEntities = [],
  highlightedIds,
  activeHighlightId = null,
  focusTarget = null,
  cameraMode = 'orbit',
  cameraPreset = 'perspective',
  savedCameraView = null,
  onCameraCaptureReady,
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
  onSwitchTo2D,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [viewportFailure, setViewportFailure] = useState<Viewport3DFailure | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [pins, setPins] = useState<ProjectedPin[]>([]);
  const skipFirstRebuildRef = useRef(true);
  const skipFirstCameraRef = useRef(true);

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
  const onCameraCaptureReadyRef = useRef(onCameraCaptureReady);
  const pendingPlaceRef = useRef(pendingPlaceItem);
  const projectRef = useRef(project);
  const activeFloorRef = useRef(activeFloor);
  const floorViewModeRef = useRef<FloorView3DMode>(floorViewMode);
  const selectedIdRef = useRef(selectedPointId);
  const selectedIdsRef = useRef(selectedIds);
  const highlightedIdsRef = useRef(highlightedIds);
  const activeHighlightIdRef = useRef(activeHighlightId);
  const cameraModeRef = useRef(cameraMode);
  const cameraPresetRef = useRef<CameraPreset>(cameraPreset);
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
  onCameraCaptureReadyRef.current = onCameraCaptureReady;
  pendingPlaceRef.current = pendingPlaceItem;
  projectRef.current = project;
  activeFloorRef.current = activeFloor;
  floorViewModeRef.current = floorViewMode;
  selectedIdRef.current = selectedPointId;
  selectedIdsRef.current = selectedIds;
  highlightedIdsRef.current = highlightedIds;
  activeHighlightIdRef.current = activeHighlightId;
  cameraModeRef.current = cameraMode;
  cameraPresetRef.current = cameraPreset;
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
    orthoCamera: THREE.OrthographicCamera;
    getActiveCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera;
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
    transitionCamera: (
      mode: CameraMode,
      zoomPct: number,
      immediate?: boolean,
      preset?: CameraPreset
    ) => void;
    applySavedCameraView: (view: SavedCameraView) => void;
    captureCurrentCameraView: () => SavedCameraView | null;
    focusOnTarget: (target: StudioFocusTarget) => void;
    rebuildScene: () => void;
    beginDragFromPin: (pointId: string, floorNum: number, clientX: number, clientY: number) => void;
  } | null>(null);

  // Initialize Three.js WebGLRenderer once per initAttempt with full lifecycle protection
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    setViewportFailure(null);

    const isSoftwareGl = detectSoftwareGl();
    const sceneScale = previewOnly ? 1 : PREVIEW_3D_SCALE;

    // Track every resource so partial initialization failures & unmounts dispose cleanly
    let disposed = false;
    let contextLost = false;
    let frameId = 0;
    let initialSizeRaf = 0;
    let spinTimer = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastPinSync = 0;
    let lastViewportW = 0;
    let lastViewportH = 0;
    let currentStage = 'WebGLRenderer initialization';

    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let controls: OrbitControls | null = null;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    let grid: THREE.GridHelper | null = null;
    let skyAtmosphere: SkyAtmosphereHandles | null = null;
    let textures: ArchitecturalTextureSet | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let listenersAttached = false;
    let contextListenersAttached = false;
    let windowResizeAttached = false;

    // Listener references initialized before attach so cleanup can always remove them safely
    let onContextLost: ((e: Event) => void) | null = null;
    let onContextRestored: (() => void) | null = null;
    let onPointerDown: ((e: PointerEvent) => void) | null = null;
    let onPointerMove: ((e: PointerEvent) => void) | null = null;
    let onWindowPointerUp: (() => void) | null = null;
    let onPointerUp: ((e: PointerEvent) => void) | null = null;
    let onContextMenu: ((e: MouseEvent) => void) | null = null;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
    let onKeyUp: ((e: KeyboardEvent) => void) | null = null;
    let onWindowBlur: (() => void) | null = null;
    let onWindowResize: (() => void) | null = null;

    const stopLoopsAndTimers = () => {
      if (spinTimer) {
        clearInterval(spinTimer);
        spinTimer = 0;
      }
      if (initialSizeRaf) {
        cancelAnimationFrame(initialSizeRaf);
        initialSizeRaf = 0;
      }
      if (frameId) {
        cancelAnimationFrame(frameId);
        clearTimeout(frameId);
        frameId = 0;
      }
      renderBusy = false;
      renderDirty = false;
    };

    const disposeAllResources = () => {
      if (disposed) return;
      disposed = true;
      stopLoopsAndTimers();

      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch {
          // Ignore disconnect errors during teardown
        }
        resizeObserver = null;
      }

      if (windowResizeAttached && onWindowResize) {
        window.removeEventListener('resize', onWindowResize);
        windowResizeAttached = false;
      }

      if (listenersAttached && renderer) {
        if (onPointerDown) renderer.domElement.removeEventListener('pointerdown', onPointerDown, true);
        if (onContextMenu) renderer.domElement.removeEventListener('contextmenu', onContextMenu);
        if (onPointerUp) renderer.domElement.removeEventListener('pointerup', onPointerUp);
        if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
        if (onWindowPointerUp) window.removeEventListener('pointerup', onWindowPointerUp);
        if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
        if (onKeyUp) window.removeEventListener('keyup', onKeyUp);
        if (onWindowBlur) window.removeEventListener('blur', onWindowBlur);
        listenersAttached = false;
      }

      if (contextListenersAttached && renderer) {
        if (onContextLost) renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
        if (onContextRestored) {
          renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
        }
        contextListenersAttached = false;
      }

      if (controls) {
        try {
          controls.dispose();
        } catch {
          // Ignore
        }
        controls = null;
      }

      if (engineRef.current?.built) {
        try {
          scene?.remove(engineRef.current.built.root);
          engineRef.current.built.dispose();
        } catch {
          // Ignore
        }
        engineRef.current.built = null;
      }

      if (grid) {
        try {
          scene?.remove(grid);
          grid.geometry?.dispose();
          if (Array.isArray(grid.material)) {
            grid.material.forEach((m) => m.dispose());
          } else {
            grid.material?.dispose();
          }
        } catch {
          // Ignore
        }
        grid = null;
      }

      if (skyAtmosphere) {
        try {
          scene?.remove(skyAtmosphere.root);
          skyAtmosphere.dispose();
        } catch {
          // Ignore
        }
        skyAtmosphere = null;
      }

      if (textures) {
        try {
          textures.dispose();
        } catch {
          // Ignore
        }
        textures = null;
      }

      if (envRenderTarget) {
        try {
          if (scene) scene.environment = null;
          envRenderTarget.dispose();
        } catch {
          // Ignore
        }
        envRenderTarget = null;
      }

      if (renderer) {
        try {
          const domEl = renderer.domElement;
          renderer.dispose();
          if (domEl.parentNode === container) {
            container.removeChild(domEl);
          }
        } catch {
          // Ignore
        }
        renderer = null;
      }

      engineRef.current = null;
      setPins([]);
    };

    const failViewport = (stage: string, err: unknown, keepForContextRestore = false) => {
      const detail = formatViewportError(err);
      console.error(
        `[Viewport3D] 3D viewport failed during "${stage}": ${detail}`,
        err instanceof Error ? { error: err, stack: err.stack } : err
      );

      if (keepForContextRestore) {
        stopLoopsAndTimers();
        setPins([]);
      } else {
        disposeAllResources();
      }

      setViewportFailure({
        stage,
        message: detail,
        recoverable: keepForContextRestore,
      });
    };

    const createEnvironmentMap = (
      activeRenderer: THREE.WebGLRenderer,
      activeScene: THREE.Scene
    ): THREE.WebGLRenderTarget | null => {
      let pmrem: THREE.PMREMGenerator | null = null;
      let roomEnv: RoomEnvironment | null = null;
      try {
        pmrem = new THREE.PMREMGenerator(activeRenderer);
        roomEnv = new RoomEnvironment();
        const rt = pmrem.fromScene(roomEnv, 0.04);
        activeScene.environment = rt.texture;
        return rt;
      } catch (err) {
        console.error(
          '[Viewport3D] PMREMGenerator / RoomEnvironment initialization failed; continuing with 3-point studio lighting:',
          err instanceof Error ? { error: err, stack: err.stack } : err
        );
        const gl = activeRenderer.getContext();
        if (!gl || gl.isContextLost()) {
          throw err;
        }
        activeScene.environment = null;
        return null;
      } finally {
        try {
          roomEnv?.dispose();
        } catch {
          // Ignore
        }
        try {
          pmrem?.dispose();
        } catch {
          // Ignore
        }
      }
    };

    try {
      // 1. WebGLRenderer creation & context verification
      currentStage = 'WebGLRenderer initialization';
      const createdRenderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
        alpha: false,
      });
      renderer = createdRenderer;

      const initialGl = createdRenderer.getContext();
      if (!initialGl || initialGl.isContextLost()) {
        throw new Error('WebGL rendering context could not be created or was immediately lost.');
      }

      const width = Math.max(container.clientWidth || 0, 320);
      const height = Math.max(container.clientHeight || 0, 220);
      lastViewportW = width;
      lastViewportH = height;

      createdRenderer.setSize(width, height, false);
      createdRenderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      createdRenderer.outputColorSpace = THREE.SRGBColorSpace;
      createdRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      createdRenderer.toneMappingExposure = 1.12;
      createdRenderer.shadowMap.enabled = !isSoftwareGl;
      createdRenderer.shadowMap.type = THREE.PCFShadowMap;
      createdRenderer.domElement.style.display = 'block';
      createdRenderer.domElement.style.width = '100%';
      createdRenderer.domElement.style.height = '100%';
      container.appendChild(createdRenderer.domElement);

      // 2. Scene + Fog + RoomEnvironment Studio Reflections
      currentStage = 'PMREMGenerator & RoomEnvironment';
      const createdScene = new THREE.Scene();
      scene = createdScene;
      createdScene.background = new THREE.Color(0x080f20);
      createdScene.fog = new THREE.FogExp2(0x080f20, 0.012 / sceneScale);
      envRenderTarget = createEnvironmentMap(createdRenderer, createdScene);

      // 3. Dual Perspective + Orthographic Cameras & OrbitControls
      currentStage = 'Camera & OrbitControls initialization';
      const aspect = width / height;
      const createdCamera = new THREE.PerspectiveCamera(
        previewOnly ? 38 : 48,
        aspect,
        0.15,
        280 * sceneScale
      );
      camera = createdCamera;
      createdCamera.position.set(11.5 * sceneScale, 11.2 * sceneScale, 13.0 * sceneScale);

      let orthoHalfHeight = 11 * sceneScale;
      const createdOrthoCamera = new THREE.OrthographicCamera(
        -orthoHalfHeight * aspect,
        orthoHalfHeight * aspect,
        orthoHalfHeight,
        -orthoHalfHeight,
        0.1,
        360 * sceneScale
      );
      createdOrthoCamera.position.copy(createdCamera.position);

      let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera = createdCamera;

      const updateOrthoFrustum = (w: number, h: number) => {
        const a = w / Math.max(1, h);
        createdOrthoCamera.left = -orthoHalfHeight * a;
        createdOrthoCamera.right = orthoHalfHeight * a;
        createdOrthoCamera.top = orthoHalfHeight;
        createdOrthoCamera.bottom = -orthoHalfHeight;
        createdOrthoCamera.updateProjectionMatrix();
      };

      const createdControls = new OrbitControls(createdCamera, createdRenderer.domElement);
      controls = createdControls;
      createdControls.enableDamping = !isSoftwareGl;
      createdControls.dampingFactor = 0.07;
      createdControls.maxPolarAngle = Math.PI / 2 - 0.02;
      createdControls.minDistance = previewOnly ? 4 : 3.2;
      createdControls.maxDistance = 42 * sceneScale;
      createdControls.enablePan = !previewOnly;
      createdControls.target.set(0, 0.6 * sceneScale, 0);
      createdControls.update();

      // CAD Ground Grid scaled 1:3 so each cell equals 1m of the 2D drawing
      const createdGrid = new THREE.GridHelper(44 * sceneScale, 44, 0x00a8ff, 0x1d2b44);
      grid = createdGrid;
      createdGrid.position.y = -0.25 * sceneScale;
      if (Array.isArray(createdGrid.material)) {
        createdGrid.material.forEach((m) => {
          m.transparent = true;
          m.opacity = 0.35;
        });
      } else {
        createdGrid.material.transparent = true;
        createdGrid.material.opacity = 0.35;
      }
      createdScene.add(createdGrid);

      // 3-Point Warm/Cool Studio Architectural Lighting Rig scaled to match 1:3 scene bounds
      const hemiLight = new THREE.HemisphereLight(0xcbe8ff, 0x1e293b, 0.95);
      createdScene.add(hemiLight);

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
      createdScene.add(keyLight);

      const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.65);
      rimLight.position.set(-14 * sceneScale, 10 * sceneScale, -12 * sceneScale);
      createdScene.add(rimLight);

      // Warm interior ambiance light for Evening / Sunset / Sunrise mode
      const eveningFill = new THREE.PointLight(0xffb454, 0, 22 * sceneScale, 1.4);
      eveningFill.position.set(0, 3.2 * sceneScale, 0);
      createdScene.add(eveningFill);

      // 4. Procedural Sky Atmosphere (Sun, Sunrise, Sunset, Night + Drifting Clouds + Soaring Birds)
      currentStage = 'createSkyAtmosphere()';
      const createdSky = createSkyAtmosphere(sceneScale);
      skyAtmosphere = createdSky;
      createdScene.add(createdSky.root);

      // 5. Procedural Architectural PBR Textures
      currentStage = 'createArchitecturalTextures()';
      const maxAniso = Math.max(1, createdRenderer.capabilities?.getMaxAnisotropy?.() || 1);
      const createdTextures = createArchitecturalTextures(maxAniso);
      textures = createdTextures;

      // Camera transition & FPS walk state
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

      const afterDraw = (cb: () => void) => {
        try {
          const gl = createdRenderer.getContext() as WebGL2RenderingContext;
          if (gl && !gl.isContextLost() && typeof gl.fenceSync === 'function') {
            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            const poll = () => {
              if (disposed || contextLost) return;
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
        const w = createdRenderer.domElement.clientWidth;
        const h = createdRenderer.domElement.clientHeight;
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
          _projVec.copy(worldPos).multiplyScalar(sceneScale).project(activeCamera);
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
      let elapsedTime = 0;

      const requestRender = () => {
        if (disposed || contextLost) return;
        if (renderBusy) {
          renderDirty = true;
          return;
        }
        renderBusy = true;
        frameId = requestAnimationFrame(() => {
          if (disposed || contextLost) {
            renderBusy = false;
            return;
          }
          renderDirty = false;

          try {
            const gl = createdRenderer.getContext();
            if (!gl || gl.isContextLost()) {
              renderBusy = false;
              return;
            }

            const dt = Math.min(0.05, clock.getDelta());

            // Smooth camera transitions
            if (transitionActive) {
              const factor = isSoftwareGl ? 1 : 1 - Math.exp(-7 * dt);
              activeCamera.position.lerp(_targetCamPos, factor);
              createdControls.target.lerp(_targetLook, factor);
              if (
                activeCamera.position.distanceTo(_targetCamPos) < 0.05 &&
                createdControls.target.distanceTo(_targetLook) < 0.05
              ) {
                activeCamera.position.copy(_targetCamPos);
                createdControls.target.copy(_targetLook);
                transitionActive = false;
              } else {
                renderDirty = true;
              }
            }

            // First-person W/A/S/D (uppercase or lowercase) & Arrow movement on 1:3 enlarged active floor
            if (cameraModeRef.current === 'fps' && !previewOnly) {
              const floorBaseY = getFloorElevationM(projectRef.current, activeFloorRef.current);
              const moveSpeed = 2.6 * sceneScale * dt;
              let moved = false;
              _fpsForward.set(-Math.sin(fpsYaw), 0, -Math.cos(fpsYaw));
              _fpsRight.set(Math.cos(fpsYaw), 0, -Math.sin(fpsYaw));
              if (walkKeys.forward) {
                createdCamera.position.addScaledVector(_fpsForward, moveSpeed);
                moved = true;
              }
              if (walkKeys.backward) {
                createdCamera.position.addScaledVector(_fpsForward, -moveSpeed);
                moved = true;
              }
              if (walkKeys.left) {
                createdCamera.position.addScaledVector(_fpsRight, -moveSpeed);
                moved = true;
              }
              if (walkKeys.right) {
                createdCamera.position.addScaledVector(_fpsRight, moveSpeed);
                moved = true;
              }
              if (moved) {
                transitionActive = false;
                renderDirty = true;
              }
              createdCamera.position.y = (floorBaseY + 1.48) * sceneScale;
              createdCamera.rotation.order = 'YXZ';
              createdCamera.rotation.y = fpsYaw;
              createdCamera.rotation.x = fpsPitch;
            } else {
              createdControls.update();
            }

            // Advance drifting clouds, flapping birds, and gentle fan spin
            elapsedTime += dt;
            createdSky.update(dt, elapsedTime);
            if (!isSoftwareGl && engineRef.current?.built) {
              engineRef.current.built.fanRotors.forEach((r) => {
                r.rotation.y += dt * 1.4;
              });
            }

            createdRenderer.render(createdScene, activeCamera);
            syncProjectedPins();

            const done = () => {
              renderBusy = false;
              if (renderDirty && !disposed && !contextLost) requestRender();
            };

            if (isSoftwareGl) afterDraw(done);
            else done();
          } catch (renderErr) {
            renderBusy = false;
            failViewport('renderer.render(scene, camera)', renderErr);
          }
        });
      };

      const transitionCamera = (
        mode: CameraMode,
        zoomPct: number,
        immediate = false,
        presetOverride?: CameraPreset
      ) => {
        if (disposed) return;
        const preset: CameraPreset =
          mode === 'fps' ? 'perspective' : presetOverride ?? cameraPresetRef.current ?? 'perspective';
        const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
        const safeLengthM = Number.isFinite(lengthM) && lengthM > 0.5 ? lengthM : 10;
        const safeWidthM = Number.isFinite(widthM) && widthM > 0.5 ? widthM : 8;
        const safeCeilingM = Number.isFinite(ceilingM) && ceilingM > 1.5 ? ceilingM : 3;

        const floors = getProjectFloors(projectRef.current);
        const activeCfg = floors.find((f) => f.floor === activeFloorRef.current) ?? floors[0];
        const floorBaseY = activeCfg ? activeCfg.elevationM : 0;

        const isMultiView = floorViewModeRef.current === 'all' || floorViewModeRef.current === 'exploded';
        const visible = isMultiView
          ? floors.filter((f) => f.visible !== false)
          : floorViewModeRef.current === 'up-to-active'
            ? floors.filter((f) => f.elevationM <= floorBaseY + 0.05)
            : [activeCfg];
        const list = visible.length > 0 ? visible : [activeCfg];
        const explodedExtra =
          floorViewModeRef.current === 'exploded'
            ? Math.max(0, list.length - 1) * EXPLODED_FLOOR_GAP_M
            : 0;
        const minY = list[0]?.elevationM ?? 0;
        const topCfg = list[list.length - 1];
        const maxY = (topCfg?.elevationM ?? 0) + (topCfg?.floorHeightM ?? safeCeilingM) + explodedExtra;
        const totalStackH = Math.max(safeCeilingM + STORY_SLAB_THICKNESS, maxY - minY);
        let lookX = 0;
        let lookY = (minY + totalStackH * 0.45) * sceneScale;
        let lookZ = 0;
        let spanWorld = Math.max(safeLengthM, safeWidthM, totalStackH * 1.18) * sceneScale;

        // Frame against actual built architectural geometry bounding box when available
        const builtRoot = engineRef.current?.built?.root;
        if (builtRoot && mode !== 'fps') {
          builtRoot.updateMatrixWorld(true);
          _sceneBox.setFromObject(builtRoot);
          if (!_sceneBox.isEmpty()) {
            _sceneBox.getCenter(_sceneCenter);
            _sceneBox.getSize(_sceneSize);
            if (
              Number.isFinite(_sceneCenter.x) &&
              Number.isFinite(_sceneCenter.y) &&
              Number.isFinite(_sceneCenter.z) &&
              Number.isFinite(_sceneSize.x) &&
              Number.isFinite(_sceneSize.y) &&
              Number.isFinite(_sceneSize.z)
            ) {
              lookX = _sceneCenter.x;
              lookY = _sceneCenter.y;
              lookZ = _sceneCenter.z;
              const geomSpan = Math.max(_sceneSize.x, _sceneSize.z, _sceneSize.y * 1.25);
              if (geomSpan > 0.5) {
                spanWorld = geomSpan;
              }
            }
          }
        }

        const zoomScale = 100 / Math.max(55, Math.min(160, zoomPct));
        const useOrtho = !previewOnly && mode !== 'fps' && isOrthographicPreset(preset);

        // Switch active camera cleanly without recreating renderer or controls
        const targetCam = useOrtho ? createdOrthoCamera : createdCamera;
        if (activeCamera !== targetCam) {
          targetCam.position.copy(activeCamera.position);
          activeCamera = targetCam;
          (createdControls as unknown as { object: THREE.Camera }).object = activeCamera;
        }

        if (useOrtho) {
          orthoHalfHeight = Math.max(4 * sceneScale, spanWorld * 0.62 * zoomScale);
          createdOrthoCamera.zoom = 1;
          updateOrthoFrustum(lastViewportW || width, lastViewportH || height);
          createdControls.maxPolarAngle = Math.PI - 0.02;
        } else {
          createdControls.maxPolarAngle = Math.PI / 2 - 0.02;
        }

        if (mode === 'fps' && !previewOnly) {
          clearWalkKeys();
          createdControls.enabled = false;
          _targetCamPos.set(
            -safeLengthM * 0.25 * sceneScale,
            (floorBaseY + 1.48) * sceneScale,
            safeWidthM * 0.15 * sceneScale
          );
          _targetLook.set(
            safeLengthM * 0.2 * sceneScale,
            (floorBaseY + 1.42) * sceneScale,
            -safeWidthM * 0.15 * sceneScale
          );
          fpsYaw = -0.85;
          fpsPitch = -0.04;
        } else {
          clearWalkKeys();
          createdControls.enabled = true;
          const distFactor = previewOnly
            ? 0.94
            : floorViewModeRef.current === 'exploded'
              ? 0.78
              : 0.68;
          const dist = Math.max(4.5 * sceneScale, spanWorld * distFactor * zoomScale);
          const orthoDist = Math.max(12 * sceneScale, spanWorld * 1.8);

          if (preset === 'top') {
            _targetCamPos.set(lookX, lookY + orthoDist, lookZ + 0.001);
          } else if (preset === 'front') {
            _targetCamPos.set(lookX, lookY, lookZ + orthoDist);
          } else if (preset === 'rear') {
            _targetCamPos.set(lookX, lookY, lookZ - orthoDist);
          } else if (preset === 'left') {
            _targetCamPos.set(lookX - orthoDist, lookY, lookZ);
          } else if (preset === 'right') {
            _targetCamPos.set(lookX + orthoDist, lookY, lookZ);
          } else if (preset === 'isometric') {
            const iso = orthoDist * 0.62;
            _targetCamPos.set(lookX + iso, lookY + iso, lookZ + iso);
          } else {
            _targetCamPos.set(lookX + dist * 0.72, lookY + dist * 0.68, lookZ + dist * 0.86);
          }
          _targetLook.set(lookX, lookY, lookZ);
          createdControls.maxDistance = Math.max(42 * sceneScale, spanWorld * 3.5);
        }

        if (immediate || useOrtho) {
          activeCamera.position.copy(_targetCamPos);
          createdControls.target.copy(_targetLook);
          if (mode === 'fps' && !previewOnly) {
            createdCamera.rotation.order = 'YXZ';
            createdCamera.rotation.y = fpsYaw;
            createdCamera.rotation.x = fpsPitch;
          } else {
            activeCamera.lookAt(_targetLook);
            createdControls.update();
          }
          transitionActive = false;
          requestRender();
        } else {
          transitionActive = true;
          requestRender();
        }
      };

      const applySavedCameraView = (view: SavedCameraView) => {
        if (disposed || previewOnly) return;
        const useOrtho = isOrthographicPreset(view.preset);
        const targetCam = useOrtho ? createdOrthoCamera : createdCamera;
        if (activeCamera !== targetCam) {
          activeCamera = targetCam;
          (createdControls as unknown as { object: THREE.Camera }).object = activeCamera;
        }
        if (useOrtho) {
          if (view.zoom && Number.isFinite(view.zoom)) {
            createdOrthoCamera.zoom = Math.max(0.25, Math.min(8, view.zoom));
          }
          updateOrthoFrustum(lastViewportW || width, lastViewportH || height);
        }
        createdControls.enabled = true;
        _targetCamPos.set(view.position[0], view.position[1], view.position[2]);
        _targetLook.set(view.target[0], view.target[1], view.target[2]);
        activeCamera.position.copy(_targetCamPos);
        createdControls.target.copy(_targetLook);
        activeCamera.lookAt(_targetLook);
        createdControls.update();
        transitionActive = false;
        requestRender();
      };

      const captureCurrentCameraView = (): SavedCameraView | null => {
        if (disposed) return null;
        return {
          id: `cam-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          name: `Saved View`,
          preset: cameraPresetRef.current,
          position: [
            Number(activeCamera.position.x.toFixed(2)),
            Number(activeCamera.position.y.toFixed(2)),
            Number(activeCamera.position.z.toFixed(2)),
          ],
          target: [
            Number(createdControls.target.x.toFixed(2)),
            Number(createdControls.target.y.toFixed(2)),
            Number(createdControls.target.z.toFixed(2)),
          ],
          zoom: activeCamera instanceof THREE.OrthographicCamera ? activeCamera.zoom : undefined,
          createdAt: new Date().toISOString(),
        };
      };

      const focusOnTarget = (target: StudioFocusTarget) => {
        if (disposed || previewOnly || cameraModeRef.current === 'fps') return;
        const { lengthM, widthM, ceilingM } = siteToMeters(projectRef.current.site);
        const floorBaseY = getFloorElevationM(projectRef.current, target.floor);
        const wx = (target.x - lengthM / 2) * sceneScale;
        const wz = (target.y - widthM / 2) * sceneScale;
        const wy = (floorBaseY + Math.min(ceilingM - 0.2, Math.max(0.5, target.z ?? 1.1))) * sceneScale;
        createdControls.enabled = true;
        _targetLook.set(wx, wy, wz);
        _targetCamPos.set(wx + 3.2 * sceneScale, wy + 3.4 * sceneScale, wz + 3.6 * sceneScale);
        transitionActive = true;
        requestRender();
      };

      const applyLighting = (mode: LightingMode) => {
        const preset = createdSky.applyMode(mode);
        createdScene.background = new THREE.Color(preset.fogColor);
        createdScene.fog = new THREE.FogExp2(preset.fogColor, preset.fogDensity / sceneScale);

        // Align directional sunlight with the visible Sun / Sunrise / Sunset position in the sky
        const [sx, sy, sz] = preset.sunDirection;
        const sunDist = 30 * sceneScale;
        keyLight.position.set(sx * sunDist, Math.max(8 * sceneScale, sy * sunDist), sz * sunDist);
        keyLight.color.setHex(preset.keyLightColor);
        keyLight.intensity = preset.keyLightIntensity;

        hemiLight.color.setHex(preset.hemiSkyColor);
        hemiLight.groundColor.setHex(preset.hemiGroundColor);
        hemiLight.intensity = preset.hemiIntensity;

        rimLight.color.setHex(preset.rimLightColor);
        rimLight.intensity = preset.rimLightIntensity;

        eveningFill.intensity = preset.eveningFillIntensity;
        createdRenderer.toneMappingExposure = preset.exposure;
      };

      const rebuildScene = () => {
        if (disposed || contextLost || !engineRef.current) return;
        try {
          if (engineRef.current.built) {
            createdScene.remove(engineRef.current.built.root);
            engineRef.current.built.dispose();
            engineRef.current.built = null;
          }
          applyLighting(lightingModeRef.current);

          // Align ground CAD grid directly under the lowest visible floor (scaled 1:3)
          const allFloors = getProjectFloors(projectRef.current);
          const activeCfg =
            allFloors.find((f) => f.floor === activeFloorRef.current) ?? allFloors[0];
          const lowestBaseY =
            floorViewModeRef.current === 'active-only'
              ? activeCfg?.elevationM ?? 0
              : Math.min(...allFloors.filter((f) => f.visible !== false).map((f) => f.elevationM), activeCfg?.elevationM ?? 0);
          createdGrid.position.y = (lowestBaseY - 0.25) * sceneScale;

          const built = buildArchitecturalScene(
            projectRef.current,
            createdTextures,
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
          createdScene.add(built.root);
          engineRef.current.built = built;
          requestRender();
        } catch (rebuildErr) {
          failViewport('rebuildScene() / buildArchitecturalScene()', rebuildErr);
        }
      };

      createdControls.addEventListener('start', () => {
        transitionActive = false;
      });
      createdControls.addEventListener('change', () => {
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
        const rect = createdRenderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        _rayMouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        _rayMouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(_rayMouse, activeCamera);
        const { lengthM, widthM } = siteToMeters(projectRef.current.site);
        const floorBaseY = getFloorElevationM(projectRef.current, floorNum);
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
        createdControls.enabled = false;
      };

      onPointerDown = (e: PointerEvent) => {
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

        const rect = createdRenderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(_rayMouse, activeCamera);

        const clickables = engineRef.current?.built?.clickables ?? [];
        const hits = raycaster.intersectObjects(clickables, true);
        if (hits.length === 0) return;

        const hitObj = hits[0].object;
        const pid = hitObj.userData?.pointId as string | undefined;
        const fid = hitObj.userData?.furnitureId as string | undefined;

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
              snapshotRecorded: true,
              lastMoveTs: 0,
            };
            createdControls.enabled = false;
          }
          return;
        }

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
              snapshotRecorded: true,
              lastMoveTs: 0,
            };
            createdControls.enabled = false;
          }
          return;
        }

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
            createdControls.enabled = false;
          }
          return;
        }

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
            createdControls.enabled = false;
          }
        }
      };

      onPointerMove = (e: PointerEvent) => {
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

      onWindowPointerUp = () => {
        if (active3DDrag) {
          active3DDrag = null;
          if (cameraModeRef.current !== 'fps') {
            createdControls.enabled = true;
          }
        }
        isFpsDragging = false;
      };

      onPointerUp = (e: PointerEvent) => {
        isFpsDragging = false;
        if (active3DDrag) {
          active3DDrag = null;
          if (cameraModeRef.current !== 'fps') {
            createdControls.enabled = true;
          }
          return;
        }
        if (previewOnly) return;
        const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
        if (moveDist > 6) return;

        const rect = createdRenderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(_rayMouse, activeCamera);

        if (pendingPlaceRef.current && onPlaceRef.current) {
          const { lengthM, widthM } = siteToMeters(projectRef.current.site);
          const floorBaseY = getFloorElevationM(projectRef.current, activeFloorRef.current);
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

        const clickables = engineRef.current?.built?.clickables ?? [];
        const hits = raycaster.intersectObjects(clickables, true);
        if (hits.length > 0) {
          const pid = hits[0].object.userData?.pointId as string | undefined;
          const fid = hits[0].object.userData?.furnitureId as string | undefined;
          const sid = hits[0].object.userData?.staircaseId as string | undefined;
          const wid = hits[0].object.userData?.wireId as string | undefined;
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
          if (sid && onSelectEntityRef.current) {
            onSelectEntityRef.current({ kind: 'staircase', id: sid }, e.shiftKey);
            return;
          }
          if (wid && onSelectEntityRef.current) {
            onSelectEntityRef.current({ kind: 'wire', id: wid }, e.shiftKey);
            return;
          }
        } else if (!e.shiftKey && onSelectEntityRef.current) {
          onSelectEntityRef.current(null);
        }
      };

      onContextMenu = (e: MouseEvent) => {
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

      onKeyDown = (e: KeyboardEvent) => {
        if (cameraModeRef.current !== 'fps' || previewOnly) return;
        if (isEditableEventTarget(e.target)) return;
        const dir = resolve3DWalkDirection(e);
        if (dir) {
          e.preventDefault();
          walkKeys[dir] = true;
          requestRender();
        }
      };

      onKeyUp = (e: KeyboardEvent) => {
        const dir = resolve3DWalkDirectionFromCode(e.code);
        if (dir) {
          walkKeys[dir] = false;
        }
      };

      onWindowBlur = () => {
        clearWalkKeys();
        isFpsDragging = false;
      };

      // WebGL context loss & automatic recovery handlers
      onContextLost = (e: Event) => {
        e.preventDefault();
        contextLost = true;
        failViewport(
          'WebGL context lost',
          new Error('The browser GPU context was lost. Showing 2D fallback until context recovers or 3D is retried.'),
          true
        );
      };

      onContextRestored = () => {
        if (disposed) return;
        try {
          contextLost = false;
          if (envRenderTarget) {
            envRenderTarget.dispose();
            envRenderTarget = null;
          }
          envRenderTarget = createEnvironmentMap(createdRenderer, createdScene);
          createdTextures.wood.needsUpdate = true;
          createdTextures.tile.needsUpdate = true;
          createdTextures.terrazzo.needsUpdate = true;
          createdTextures.stone.needsUpdate = true;
          setViewportFailure(null);
          rebuildScene();
          if (!disposed) {
            createdRenderer.render(createdScene, activeCamera);
            if (!isSoftwareGl) {
              if (spinTimer) {
                clearInterval(spinTimer);
                spinTimer = 0;
              }
              spinTimer = window.setInterval(() => {
                if (!disposed && !contextLost && !document.hidden) requestRender();
              }, 33);
            }
          }
        } catch (restoreErr) {
          failViewport('WebGL context restore', restoreErr);
        }
      };

      createdRenderer.domElement.addEventListener('webglcontextlost', onContextLost);
      createdRenderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
      contextListenersAttached = true;

      // Capture phase so Ctrl+Click duplicate / selected-item drag takes priority over OrbitControls
      createdRenderer.domElement.addEventListener('pointerdown', onPointerDown, true);
      createdRenderer.domElement.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onWindowPointerUp);
      createdRenderer.domElement.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onWindowBlur);
      listenersAttached = true;

      // ResizeObserver with zero-size & redundant-resize guards
      const syncRendererSize = (rawW: number, rawH: number) => {
        if (disposed || contextLost) return;
        if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW < 2 || rawH < 2) return;
        const w = Math.max(100, Math.floor(rawW));
        const h = Math.max(100, Math.floor(rawH));
        if (w === lastViewportW && h === lastViewportH) return;
        lastViewportW = w;
        lastViewportH = h;
        createdCamera.aspect = w / h;
        createdCamera.updateProjectionMatrix();
        updateOrthoFrustum(w, h);
        createdRenderer.setSize(w, h, false);
        requestRender();
      };

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            syncRendererSize(entry.contentRect.width, entry.contentRect.height);
          }
        });
        resizeObserver.observe(container);
      } else {
        onWindowResize = () => {
          syncRendererSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', onWindowResize);
        windowResizeAttached = true;
      }

      initialSizeRaf = requestAnimationFrame(() => {
        initialSizeRaf = 0;
        if (!disposed && !contextLost && container.clientWidth >= 2 && container.clientHeight >= 2) {
          syncRendererSize(container.clientWidth, container.clientHeight);
        }
      });

      engineRef.current = {
        scene: createdScene,
        camera: createdCamera,
        orthoCamera: createdOrthoCamera,
        getActiveCamera: () => activeCamera,
        renderer: createdRenderer,
        controls: createdControls,
        textures: createdTextures,
        built: null,
        keyLight,
        hemiLight,
        rimLight,
        eveningFill,
        isSoftwareGl,
        requestRender,
        transitionCamera,
        applySavedCameraView,
        captureCurrentCameraView,
        focusOnTarget,
        rebuildScene,
        beginDragFromPin,
      };
      onCameraCaptureReadyRef.current?.(captureCurrentCameraView);

      // 6. Initial architectural scene construction
      currentStage = 'rebuildScene() / buildArchitecturalScene()';
      rebuildScene();
      if (disposed) return;

      // 7. Immediate camera framing onto actual built building geometry
      currentStage = 'Initial camera framing';
      transitionCamera(cameraModeRef.current, zoom, true, cameraPresetRef.current);

      // 8. Pre-warm shaders on GPU (protected)
      if (!isSoftwareGl) {
        currentStage = 'renderer.compile(scene, camera)';
        createdRenderer.compile(createdScene, activeCamera);
      }

      // 9. Verify synchronous initial scene render before declaring 3D ready
      currentStage = 'initial renderer.render(scene, camera)';
      const postInitGl = createdRenderer.getContext();
      if (!postInitGl || postInitGl.isContextLost()) {
        throw new Error('WebGL context was lost before initial frame render.');
      }
      createdRenderer.render(createdScene, activeCamera);
      syncProjectedPins();

      // Gentle continuous fan & sky animation on GPU when interactive and tab visible
      if (!isSoftwareGl) {
        if (spinTimer) {
          clearInterval(spinTimer);
          spinTimer = 0;
        }
        spinTimer = window.setInterval(() => {
          if (!disposed && !contextLost && !document.hidden) requestRender();
        }, 33);
      }
    } catch (initErr) {
      failViewport(currentStage, initErr);
      return;
    }

    return () => {
      disposeAllResources();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAttempt]);

  // Rebuild 3D geometry whenever project, selection, highlights, lighting, floor, or cutaway mode changes
  useEffect(() => {
    if (skipFirstRebuildRef.current) {
      skipFirstRebuildRef.current = false;
      return;
    }
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

  // Smoothly update camera when cameraMode, cameraPreset, zoom, site dimensions, floors count, or active floor view changes
  useEffect(() => {
    if (skipFirstCameraRef.current) {
      skipFirstCameraRef.current = false;
      return;
    }
    engineRef.current?.transitionCamera(cameraMode, zoom, false, cameraPreset);
  }, [
    cameraMode,
    cameraPreset,
    zoom,
    project.id,
    project.site.floors,
    project.site.length,
    project.site.width,
    project.floorConfigs,
    activeFloor,
    floorViewMode,
  ]);

  // Apply user-selected saved camera angle
  useEffect(() => {
    if (!savedCameraView) return;
    engineRef.current?.applySavedCameraView(savedCameraView);
  }, [savedCameraView]);

  // Smoothly frame camera onto searched/navigated component from Find Component (Ctrl+F)
  useEffect(() => {
    if (!focusTarget) return;
    engineRef.current?.focusOnTarget(focusTarget);
  }, [focusTarget]);

  return (
    <div className="relative w-full h-full flex-1 min-h-0 overflow-hidden bg-surface">
      {/* Dedicated empty mount node for WebGL canvas (kept mounted for context recovery & clean Retry 3D) */}
      <div
        ref={mountRef}
        className={`absolute inset-0 w-full h-full ${
          viewportFailure ? 'pointer-events-none opacity-0' : ''
        } ${pendingPlaceItem ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      />

      {/* Safe 2D Fallback + Diagnostic Banner when 3D initialization or rendering fails */}
      {viewportFailure && (
        <div className="absolute inset-0 z-30 flex flex-col bg-surface">
          {!previewOnly && (
            <div
              role="alert"
              className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-surface-container-high border-b border-outline text-on-surface"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="material-symbols-outlined text-secondary text-[18px] shrink-0" aria-hidden="true">
                  warning
                </span>
                <div className="min-w-0">
                  <div className="font-label text-label-sm uppercase tracking-wider text-secondary">
                    3D Viewport Fallback — Failed at {viewportFailure.stage}
                  </div>
                  <p className="font-mono text-mono-sm text-on-surface-variant truncate">
                    {viewportFailure.message}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setInitAttempt((n) => n + 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-primary text-on-primary font-label text-label-sm uppercase cursor-pointer hover:opacity-90"
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    refresh
                  </span>
                  <span>Retry 3D</span>
                </button>
                {onSwitchTo2D && (
                  <button
                    type="button"
                    onClick={onSwitchTo2D}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-surface-container border border-outline text-on-surface font-label text-label-sm uppercase cursor-pointer hover:border-primary hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      grid_on
                    </span>
                    <span>Switch to 2D</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="relative flex-1 min-h-0 w-full">
            <FloorPlan2D
              project={project}
              activeFloor={activeFloor}
              selectedPointId={selectedPointId}
              selectedEntities={selectedEntities}
              previewOnly={previewOnly}
              onSelectEntity={onSelectEntity}
              onSelectPoint={onSelectPoint}
            />
          </div>
        </div>
      )}

      {/* Interactive 3D-projected pin markers (solid dark slate/blue surfaces, zero backdrop-blur) */}
      {showPins && !previewOnly && !viewportFailure && (
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

    </div>
  );
};

interface Viewport3DErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

class Viewport3DErrorBoundary extends React.Component<
  Viewport3DProps,
  Viewport3DErrorBoundaryState
> {
  state: Viewport3DErrorBoundaryState = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<Viewport3DErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Viewport3DErrorBoundary] Caught React rendering error in 3D viewport:', {
      error,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="relative w-full h-full flex-1 min-h-0 flex flex-col bg-surface">
          {!this.props.previewOnly && (
            <div
              role="alert"
              className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-surface-container-high border-b border-outline text-on-surface"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="material-symbols-outlined text-secondary text-[18px] shrink-0">
                  warning
                </span>
                <div className="min-w-0">
                  <div className="font-label text-label-sm uppercase tracking-wider text-secondary">
                    3D Viewport Recovered — 2D Fallback Active
                  </div>
                  <p className="font-mono text-mono-sm text-on-surface-variant truncate">
                    {this.state.error.message || 'Unexpected error while rendering 3D viewport.'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    this.setState((prev) => ({ error: null, retryKey: prev.retryKey + 1 }))
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-primary text-on-primary font-label text-label-sm uppercase cursor-pointer"
                >
                  Retry 3D
                </button>
                {this.props.onSwitchTo2D && (
                  <button
                    type="button"
                    onClick={this.props.onSwitchTo2D}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-surface-container border border-outline text-on-surface font-label text-label-sm uppercase cursor-pointer"
                  >
                    Switch to 2D
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="relative flex-1 min-h-0 w-full">
            <FloorPlan2D
              project={this.props.project}
              activeFloor={this.props.activeFloor}
              selectedPointId={this.props.selectedPointId}
              selectedEntities={this.props.selectedEntities}
              previewOnly={this.props.previewOnly}
              onSelectEntity={this.props.onSelectEntity}
              onSelectPoint={this.props.onSelectPoint}
            />
          </div>
        </div>
      );
    }

    return <Viewport3DInner key={this.state.retryKey} {...this.props} />;
  }
}

export const Viewport3D: React.FC<Viewport3DProps> = (props) => (
  <Viewport3DErrorBoundary {...props} />
);

