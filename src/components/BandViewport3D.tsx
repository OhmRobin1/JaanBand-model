import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {
  ChevronDown,
  ChevronUp,
  HardHat,
  Layers,
  RotateCcw,
  RotateCw,
  Shield,
  Touchpad,
  View,
  Watch,
} from 'lucide-react';
import {
  CameraPreset,
  ConditionLevel,
  FinishOption,
  KeepAliveStatus,
  MOUNT_OPTIONS,
  MountMode,
  WorkerRecord,
} from '../types/band';

interface BandViewport3DProps {
  finish: FinishOption;
  worker: WorkerRecord | null;
  mountMode: MountMode;
  onChangeMountMode: (mode: MountMode) => void;
  condition: ConditionLevel;
  keepAliveStatus: KeepAliveStatus;
  bpm: number | null;
  skinTempC: number | null;
  isConnectedStream: boolean;
  isDiagnosing: boolean;
  exploded: boolean;
  onToggleExploded: () => void;
}

const CAMERA_PRESETS: Record<
  CameraPreset,
  {
    label: string;
    sensorDevice: string;
    sensorSpec: string;
    accentClass: string;
    accentHex: string;
    pos: [number, number, number];
    target: [number, number, number];
  }
> = {
  hero: {
    label: 'Studio',
    sensorDevice: '',
    sensorSpec: '',
    accentClass: 'text-emeraldGlow',
    accentHex: '#00e599',
    pos: [0.55, 2.25, 4.55],
    target: [0, 0.14, 0],
  },
  sensor: {
    label: 'PPG Array',
    sensorDevice: 'MAX30102 Optical PPG + TMP117 Thermistor',
    sensorSpec: '530nm/940nm HR · SpO2 · RMSSD HRV · ±0.02°C Skin',
    accentClass: 'text-emeraldGlow',
    accentHex: '#00e599',
    pos: [0.55, -0.45, 2.35],
    target: [0, 0.96, 0],
  },
  breath: {
    label: 'Breath Vent',
    sensorDevice: 'Pulsed MEMS (SGP40 / BME688) + IP67 ePTFE',
    sensorSpec: '10s Wake Ethanol Screen · 0 mA Sleep During Shift',
    accentClass: 'text-sky-300',
    accentHex: '#38bdf8',
    pos: [2.35, 1.55, 1.95],
    target: [0.36, 1.05, 0],
  },
  clasp: {
    label: 'Mount Clip',
    sensorDevice: 'Optical Lead-Off + ADXL345 3-Axis IMU',
    sensorSpec: '15s Mechanical Disconnect + 6–12 Hz Tremor Sensor',
    accentClass: 'text-titaniumGold',
    accentHex: '#e3a72f',
    pos: [1.65, -1.35, 3.05],
    target: [0, -0.75, 0],
  },
  profile: {
    label: 'Profile',
    sensorDevice: 'nRF52 BLE Radio + 10s Breath Wake Switch',
    sensorSpec: 'IK07 Polycarbonate Core · Conformal Resin Potted',
    accentClass: 'text-slate-200',
    accentHex: '#e2e8f0',
    pos: [3.65, 0.72, 1.45],
    target: [0, 0.12, 0],
  },
};

function getPresetSensorInfo(preset: CameraPreset, mountMode: MountMode) {
  if (preset === 'clasp') {
    if (mountMode === 'helmet') {
      return {
        device: 'Temporal Contact Probe + ADXL345 IMU',
        spec: 'Hardhat Suspension Clip · Optical Lead-Off Failsafe',
      };
    }
    if (mountMode === 'bicep') {
      return {
        device: 'Bicep Snap Cradle + Optical Lead-Off IMU',
        spec: 'Zero Hammer Shock · High Brachial Capillary SNR',
      };
    }
    return {
      device: '₹20 Strap Latch + Optical Lead-Off + IMU',
      spec: '15s Disconnect Failsafe · 6–12 Hz Micro-Tremor Axis',
    };
  }
  const p = CAMERA_PRESETS[preset];
  return { device: p.sensorDevice, spec: p.sensorSpec };
}

const _targetCamPos = new THREE.Vector3();
const _targetCtrl = new THREE.Vector3();
const _partPos = new THREE.Vector3();
const _partQuat = new THREE.Quaternion();
const _normalVec = new THREE.Vector3();
const _upVec = new THREE.Vector3();
const _sideVec = new THREE.Vector3();
const _projVec = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
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

export function BandViewport3D({
  finish,
  worker,
  mountMode,
  onChangeMountMode,
  condition,
  keepAliveStatus,
  bpm,
  skinTempC,
  isConnectedStream,
  isDiagnosing,
  exploded,
  onToggleExploded,
}: BandViewport3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const pinCardRef = useRef<HTMLDivElement | null>(null);
  const pinDotRef = useRef<SVGCircleElement | null>(null);
  const pinRingRef = useRef<SVGCircleElement | null>(null);
  const pinLineRef = useRef<SVGLineElement | null>(null);
  const [autoOrbit, setAutoOrbit] = useState(true);
  const [activePreset, setActivePreset] = useState<CameraPreset>('hero');
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [webglError, setWebglError] = useState(false);

  const stateRef = useRef({
    finish,
    worker,
    mountMode,
    condition,
    keepAliveStatus,
    bpm,
    skinTempC,
    isConnectedStream,
    isDiagnosing,
    exploded,
    autoOrbit,
    presetTransitionActive: false,
    preset: 'hero' as CameraPreset,
  });

  stateRef.current.finish = finish;
  stateRef.current.worker = worker;
  stateRef.current.mountMode = mountMode;
  stateRef.current.condition = condition;
  stateRef.current.keepAliveStatus = keepAliveStatus;
  stateRef.current.bpm = bpm;
  stateRef.current.skinTempC = skinTempC;
  stateRef.current.isConnectedStream = isConnectedStream;
  stateRef.current.isDiagnosing = isDiagnosing;
  stateRef.current.exploded = exploded;
  stateRef.current.autoOrbit = autoOrbit;

  const triggerPreset = (preset: CameraPreset) => {
    setActivePreset(preset);
    stateRef.current.preset = preset;
    stateRef.current.presetTransitionActive = true;
    if (preset === 'hero') {
      setAutoOrbit(true);
    } else {
      setAutoOrbit(false);
    }
  };

  useEffect(() => {
    stateRef.current.presetTransitionActive = true;
  }, [mountMode]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const width = container.clientWidth || 380;
    const height = container.clientHeight || 380;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError(true);
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      setWebglError(true);
    };
    const handleContextRestored = () => {
      setWebglError(false);
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070b0e, 0.042);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(...CAMERA_PRESETS.hero.pos);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 8.2;
    controls.target.set(...CAMERA_PRESETS.hero.target);

    controls.addEventListener('start', () => {
      stateRef.current.presetTransitionActive = false;
    });

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTex = pmremGenerator.fromScene(roomEnv, 0.04).texture;
    scene.environment = envTex;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const hemiLight = new THREE.HemisphereLight(0xcbe7ff, 0x101820, 0.78);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff6e8, 2.25);
    keyLight.position.set(4, 5.5, 4.5);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 16;
      keyLight.shadow.camera.left = -2.8;
      keyLight.shadow.camera.right = 2.8;
      keyLight.shadow.camera.top = 2.8;
      keyLight.shadow.camera.bottom = -2.8;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.85);
    rimLight.position.set(-3.5, 3.5, -4.5);
    scene.add(rimLight);

    const fillEmeraldLight = new THREE.DirectionalLight(0x00e599, 1.15);
    fillEmeraldLight.position.set(-4.5, -1.2, 2.8);
    scene.add(fillEmeraldLight);

    const goldWarmLight = new THREE.PointLight(0xe3a72f, 1.15, 10);
    goldWarmLight.position.set(2.2, -2.0, 2.2);
    scene.add(goldWarmLight);

    const focusLight = new THREE.PointLight(0x00e599, 0, 4.0);
    scene.add(focusLight);

    if (!isSoftwareGl) {
      RectAreaLightUniformsLib.init();
      const topSoftbox = new THREE.RectAreaLight(0xffffff, 2.8, 3.5, 1.4);
      topSoftbox.position.set(0, 3.4, 1.6);
      topSoftbox.lookAt(0, 0.3, 0);
      scene.add(topSoftbox);
    }

    // Grounded Contact Shadow
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 256;
    shadowCanvas.height = 256;
    const sCtx = shadowCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(128, 128, 12, 128, 128, 124);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
      grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.25)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 256, 256);
    }
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 3.2),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.65,
      }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = -1.72;
    scene.add(contactShadow);

    const bandGroup = new THREE.Group();
    scene.add(bandGroup);

    // Procedural micro-groove texture
    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = 128;
    bumpCanvas.height = 128;
    const bCtx = bumpCanvas.getContext('2d');
    if (bCtx) {
      bCtx.fillStyle = '#808080';
      bCtx.fillRect(0, 0, 128, 128);
      bCtx.fillStyle = '#9a9a9a';
      for (let i = 0; i < 128; i += 4) {
        bCtx.fillRect(0, i, 128, 1.5);
      }
    }
    const bumpTex = new THREE.CanvasTexture(bumpCanvas);
    bumpTex.wrapS = THREE.RepeatWrapping;
    bumpTex.wrapT = THREE.RepeatWrapping;
    bumpTex.repeat.set(12, 42);

    const bandMat = new THREE.MeshStandardMaterial({
      color: finish.bandColor,
      roughness: finish.bandRoughness,
      metalness: finish.bandMetalness,
      bumpMap: bumpTex,
      bumpScale: 0.016,
    });

    const claspMat = new THREE.MeshPhysicalMaterial({
      color: finish.claspColor,
      roughness: finish.claspRoughness,
      metalness: finish.claspMetalness,
      anisotropy: 0.8,
      clearcoat: 0.25,
    });

    const claspRingMat = new THREE.MeshStandardMaterial({
      color: 0x0b0e12,
      roughness: 0.3,
      metalness: 0.7,
    });

    // =========================================================================
    // MOUNT 1: WRIST SILICONE STRAP (₹20 Replaceable Elastomer Loop + Clasp)
    // =========================================================================
    const wristMountGroup = new THREE.Group();
    bandGroup.add(wristMountGroup);

    const rx = 1.54;
    const ry = 1.12;
    class WristCurve extends THREE.Curve<THREE.Vector3> {
      constructor() {
        super();
      }
      getPoint(t: number, optionalTarget = new THREE.Vector3()) {
        const angle = 2 * Math.PI * t;
        return optionalTarget.set(Math.sin(angle) * rx, Math.cos(angle) * ry, 0);
      }
    }
    const wristGeo = new THREE.TubeGeometry(new WristCurve(), 160, 0.24, 24, true);
    const wPos = wristGeo.attributes.position;
    for (let i = 0; i < wPos.count; i++) {
      const vx = wPos.getX(i);
      const vy = wPos.getY(i);
      const theta = Math.atan2(vx / rx, vy / ry);
      const cx = Math.sin(theta) * rx;
      const cy = Math.cos(theta) * ry;
      wPos.setX(i, cx + (vx - cx) * 0.36);
      wPos.setY(i, cy + (vy - cy) * 0.36);
    }
    wristGeo.computeVertexNormals();
    const wristMesh = new THREE.Mesh(wristGeo, bandMat);
    wristMesh.castShadow = true;
    wristMesh.receiveShadow = true;
    wristMountGroup.add(wristMesh);

    const claspGroup = new THREE.Group();
    const claspShape = new THREE.Shape();
    const clW = 0.17;
    const clH = 0.245;
    const clR = 0.05;
    claspShape.moveTo(-clW + clR, -clH);
    claspShape.lineTo(clW - clR, -clH);
    claspShape.quadraticCurveTo(clW, -clH, clW, -clH + clR);
    claspShape.lineTo(clW, clH - clR);
    claspShape.quadraticCurveTo(clW, clH, clW - clR, clH);
    claspShape.lineTo(-clW + clR, clH);
    claspShape.quadraticCurveTo(-clW, clH, -clW, clH - clR);
    claspShape.lineTo(-clW, -clH + clR);
    claspShape.quadraticCurveTo(-clW, -clH, -clW + clR, -clH);

    const claspMainGeo = new THREE.ExtrudeGeometry(claspShape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelSegments: 3,
      steps: 1,
      bevelSize: 0.025,
      bevelThickness: 0.025,
    });
    claspMainGeo.center();
    claspMainGeo.rotateX(-Math.PI / 2);
    const claspMain = new THREE.Mesh(claspMainGeo, claspMat);
    claspMain.castShadow = true;
    claspGroup.add(claspMain);

    const claspTrimGeo = new THREE.BoxGeometry(0.022, 0.215, 0.515);
    const claspTrimL = new THREE.Mesh(claspTrimGeo, claspRingMat);
    claspTrimL.position.x = -0.145;
    claspGroup.add(claspTrimL);

    const claspTrimR = claspTrimL.clone();
    claspTrimR.position.x = 0.145;
    claspGroup.add(claspTrimR);

    claspGroup.position.set(0, -1.12, 0);
    wristMountGroup.add(claspGroup);

    // =========================================================================
    // MOUNT 2: UPPER BICEP ARMBAND (Wide Breathable Elasticated Industrial Cuff)
    // =========================================================================
    const bicepMountGroup = new THREE.Group();
    bandGroup.add(bicepMountGroup);

    const brx = 1.92;
    const bry = 1.32;
    class BicepCurve extends THREE.Curve<THREE.Vector3> {
      constructor() {
        super();
      }
      getPoint(t: number, optionalTarget = new THREE.Vector3()) {
        const angle = 2 * Math.PI * t;
        return optionalTarget.set(Math.sin(angle) * brx, Math.cos(angle) * bry, 0);
      }
    }
    const bicepGeo = new THREE.TubeGeometry(new BicepCurve(), 160, 0.34, 24, true);
    const bPos = bicepGeo.attributes.position;
    for (let i = 0; i < bPos.count; i++) {
      const vx = bPos.getX(i);
      const vy = bPos.getY(i);
      const theta = Math.atan2(vx / brx, vy / bry);
      const cx = Math.sin(theta) * brx;
      const cy = Math.cos(theta) * bry;
      bPos.setX(i, cx + (vx - cx) * 0.28);
      bPos.setY(i, cy + (vy - cy) * 0.28);
    }
    bicepGeo.computeVertexNormals();

    const bicepBandMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.72,
      metalness: 0.08,
      bumpMap: bumpTex,
      bumpScale: 0.024,
    });
    const bicepMesh = new THREE.Mesh(bicepGeo, bicepBandMat);
    bicepMesh.castShadow = true;
    bicepMesh.receiveShadow = true;
    bicepMountGroup.add(bicepMesh);

    const bicepBuckleGeo = new THREE.BoxGeometry(0.18, 0.18, 0.72);
    const bicepBuckleL = new THREE.Mesh(bicepBuckleGeo, claspMat);
    bicepBuckleL.position.set(-1.32, 0.94, 0);
    bicepBuckleL.rotation.z = 0.62;
    bicepMountGroup.add(bicepBuckleL);

    const bicepBuckleR = bicepBuckleL.clone();
    bicepBuckleR.position.set(1.32, 0.94, 0);
    bicepBuckleR.rotation.z = -0.62;
    bicepMountGroup.add(bicepBuckleR);

    // Quick-release snap cradle sitting under the puck on Bicep
    const cradleMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.32,
      metalness: 0.65,
    });
    const bicepCradleGeo = new THREE.BoxGeometry(0.96, 0.075, 0.58);
    const bicepCradle = new THREE.Mesh(bicepCradleGeo, cradleMat);
    bicepCradle.position.set(0, 1.32, 0);
    bicepMountGroup.add(bicepCradle);

    // =========================================================================
    // MOUNT 3: HARDHAT / HELMET LINER CLIP (Swept Safety Shell + Temporal Probe)
    // =========================================================================
    const helmetMountGroup = new THREE.Group();
    bandGroup.add(helmetMountGroup);

    const helmetShellMat = new THREE.MeshPhysicalMaterial({
      color: 0xeab308, // High-visibility safety construction helmet yellow
      roughness: 0.22,
      metalness: 0.08,
      clearcoat: 0.85,
      clearcoatRoughness: 0.12,
      side: THREE.DoubleSide,
    });
    // Swept industrial hardhat dome cap
    const helmetDomeGeo = new THREE.SphereGeometry(
      1.78,
      40,
      20,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.42,
    );
    const helmetDome = new THREE.Mesh(helmetDomeGeo, helmetShellMat);
    helmetDome.position.set(0, -0.05, 0);
    helmetDome.scale.set(0.94, 0.88, 1.12);
    helmetDome.castShadow = true;
    helmetMountGroup.add(helmetDome);

    // Center safety crest ridge
    const crestGeo = new THREE.BoxGeometry(0.16, 0.22, 2.25);
    const crestMesh = new THREE.Mesh(crestGeo, helmetShellMat);
    crestMesh.position.set(0, 1.45, -0.05);
    helmetMountGroup.add(crestMesh);

    // Front visor brim
    const brimGeo = new THREE.CylinderGeometry(
      1.75,
      1.86,
      0.06,
      36,
      1,
      true,
      -Math.PI * 0.34,
      Math.PI * 0.68,
    );
    const brimMesh = new THREE.Mesh(brimGeo, helmetShellMat);
    brimMesh.position.set(0, 0.38, 0.14);
    helmetMountGroup.add(brimMesh);

    // Inner suspension headband arc (holds JaanBand puck flush at forehead temporal site)
    const linerMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.55,
      metalness: 0.25,
    });
    const linerGeo = new THREE.TorusGeometry(1.48, 0.075, 16, 48, Math.PI * 1.45);
    const linerMesh = new THREE.Mesh(linerGeo, linerMat);
    linerMesh.rotation.x = Math.PI / 2;
    linerMesh.rotation.z = -Math.PI * 0.225;
    linerMesh.position.set(0, 0.42, 0);
    helmetMountGroup.add(linerMesh);

    // Spring-clip receiver bracket gripping the puck at forehead suspension
    const clipBracketGeo = new THREE.BoxGeometry(0.98, 0.32, 0.14);
    const clipBracket = new THREE.Mesh(clipBracketGeo, claspMat);
    clipBracket.position.set(0, 0.44, 1.56);
    helmetMountGroup.add(clipBracket);

    // =========================================================================
    // SHARED CORE PUCK ASSEMBLY (IK07 Polycarbonate Shell + Conformal Potting)
    // =========================================================================
    const coreGroup = new THREE.Group();
    bandGroup.add(coreGroup);

    const chassisShape = new THREE.Shape();
    const cw = 0.46;
    const ch = 0.25;
    const cr = 0.095;
    chassisShape.moveTo(-cw + cr, -ch);
    chassisShape.lineTo(cw - cr, -ch);
    chassisShape.quadraticCurveTo(cw, -ch, cw, -ch + cr);
    chassisShape.lineTo(cw, ch - cr);
    chassisShape.quadraticCurveTo(cw, ch, cw - cr, ch);
    chassisShape.lineTo(-cw + cr, ch);
    chassisShape.quadraticCurveTo(-cw, ch, -cw, ch - cr);
    chassisShape.lineTo(-cw, -ch + cr);
    chassisShape.quadraticCurveTo(-cw, -ch, -cw + cr, -ch);

    const coreCaseGeo = new THREE.ExtrudeGeometry(chassisShape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelSegments: 4,
      steps: 1,
      bevelSize: 0.028,
      bevelThickness: 0.028,
    });
    coreCaseGeo.center();

    const chassisMat = new THREE.MeshPhysicalMaterial({
      color: finish.chassisColor,
      roughness: finish.chassisRoughness,
      metalness: finish.chassisMetalness,
      anisotropy: 0.8,
      clearcoat: 0.35,
      clearcoatRoughness: 0.15,
    });
    const coreCase = new THREE.Mesh(coreCaseGeo, chassisMat);
    coreCase.castShadow = true;
    coreCase.receiveShadow = true;
    coreGroup.add(coreCase);

    // Conformal polyurethane potting seal gasket (visible when puck pops out)
    const pottingRingGeo = new THREE.BoxGeometry(0.92, 0.49, 0.045);
    const pottingRingMat = new THREE.MeshStandardMaterial({
      color: 0x00e599,
      roughness: 0.35,
      metalness: 0.2,
      emissive: 0x003322,
      emissiveIntensity: 0.5,
    });
    const pottingRing = new THREE.Mesh(pottingRingGeo, pottingRingMat);
    pottingRing.position.z = -0.05;
    coreGroup.add(pottingRing);

    // Titanium Bezel Frame
    const bezelGeo = new THREE.BoxGeometry(0.84, 0.43, 0.036);
    const bezelMesh = new THREE.Mesh(bezelGeo, claspMat);
    bezelMesh.position.z = 0.096;
    coreGroup.add(bezelMesh);

    // Side IP67 ePTFE Hydrophobic Breath-Alcohol Vent + Pulsed MEMS Ethanol Die (+X flank)
    const breathAssembly = new THREE.Group();
    breathAssembly.position.set(0.47, 0.01, 0.01);
    coreGroup.add(breathAssembly);

    const ventCollarGeo = new THREE.CylinderGeometry(0.088, 0.096, 0.04, 24);
    const ventCollarMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.25,
      metalness: 0.88,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0,
    });
    const ventCollar = new THREE.Mesh(ventCollarGeo, ventCollarMat);
    ventCollar.rotation.z = Math.PI / 2;
    breathAssembly.add(ventCollar);

    const eptfeMembraneGeo = new THREE.CylinderGeometry(0.064, 0.064, 0.044, 24);
    const eptfeMembraneMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.88,
      metalness: 0.05,
      emissive: 0x0284c7,
      emissiveIntensity: 0,
    });
    const eptfeMembrane = new THREE.Mesh(eptfeMembraneGeo, eptfeMembraneMat);
    eptfeMembrane.rotation.z = Math.PI / 2;
    breathAssembly.add(eptfeMembrane);

    const ventRingGeo = new THREE.RingGeometry(0.068, 0.084, 24);
    const ventRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
    });
    const ventRing = new THREE.Mesh(ventRingGeo, ventRingMat);
    ventRing.rotation.y = Math.PI / 2;
    ventRing.position.x = 0.023;
    breathAssembly.add(ventRing);

    const memsPcbGeo = new THREE.BoxGeometry(0.015, 0.125, 0.125);
    const memsPcbMat = new THREE.MeshStandardMaterial({
      color: 0x064e3b,
      roughness: 0.35,
      metalness: 0.45,
      emissive: 0x059669,
      emissiveIntensity: 0.1,
    });
    const memsPcb = new THREE.Mesh(memsPcbGeo, memsPcbMat);
    memsPcb.position.x = -0.056;
    breathAssembly.add(memsPcb);

    const memsDieGeo = new THREE.BoxGeometry(0.025, 0.085, 0.085);
    const memsDieMat = new THREE.MeshStandardMaterial({
      color: 0xe3a72f,
      roughness: 0.28,
      metalness: 0.85,
      emissive: 0xe3a72f,
      emissiveIntensity: 0.15,
    });
    const memsDie = new THREE.Mesh(memsDieGeo, memsDieMat);
    memsDie.position.x = -0.036;
    breathAssembly.add(memsDie);

    const memsWindowGeo = new THREE.BoxGeometry(0.01, 0.045, 0.045);
    const memsWindowMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc });
    const memsWindow = new THREE.Mesh(memsWindowGeo, memsWindowMat);
    memsWindow.position.x = -0.02;
    breathAssembly.add(memsWindow);

    // Highlight Halo + Airflow Wave Rings for Breath Vent focus
    const breathHaloGroup = new THREE.Group();
    breathHaloGroup.position.x = 0.032;
    breathHaloGroup.rotation.y = Math.PI / 2;
    breathHaloGroup.visible = false;
    breathAssembly.add(breathHaloGroup);

    const breathHaloInnerGeo = new THREE.RingGeometry(0.105, 0.128, 32);
    const breathHaloInnerMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const breathHaloInner = new THREE.Mesh(breathHaloInnerGeo, breathHaloInnerMat);
    breathHaloGroup.add(breathHaloInner);

    const breathHaloWaveGeo = new THREE.RingGeometry(0.145, 0.168, 32);
    const breathHaloWaveMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const breathHaloWave = new THREE.Mesh(breathHaloWaveGeo, breathHaloWaveMat);
    breathHaloGroup.add(breathHaloWave);

    // Opposite (-X) Tactile 10s Breath-Wake Button + nRF52 / ADXL345 Silicon Accent
    const wakeBtnGeo = new THREE.BoxGeometry(0.04, 0.16, 0.065);
    const wakeBtn = new THREE.Mesh(wakeBtnGeo, claspMat);
    wakeBtn.position.set(-0.48, 0.0, 0.01);
    coreGroup.add(wakeBtn);

    const imuChipGeo = new THREE.BoxGeometry(0.018, 0.09, 0.09);
    const imuChipMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.25,
      metalness: 0.85,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.15,
    });
    const imuChip = new THREE.Mesh(imuChipGeo, imuChipMat);
    imuChip.position.set(-0.43, 0.0, 0.01);
    coreGroup.add(imuChip);

    // Dynamic OLED Canvas
    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = 512;
    displayCanvas.height = 256;
    const dCtx = displayCanvas.getContext('2d');
    const displayTex = new THREE.CanvasTexture(displayCanvas);
    displayTex.colorSpace = THREE.SRGBColorSpace;
    displayTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const updateOled = (elapsed: number) => {
      if (!dCtx) return;
      const {
        worker: curWorker,
        mountMode: curMount,
        condition: curCondition,
        keepAliveStatus: ka,
        bpm: curBpm,
        skinTempC: curTemp,
        isConnectedStream: streamUp,
        isDiagnosing: diagnosing,
        finish: curFinish,
      } = stateRef.current;

      const isDisc = ka.state === 'disconnected';
      const hasReport = curBpm !== null && curTemp !== null;
      const isCritical = isDisc || curCondition === 'critical';
      const isCaution = !isCritical && curCondition === 'caution';
      const signalColor = diagnosing
        ? '#38bdf8'
        : isCritical
          ? '#f97316'
          : isCaution
            ? '#e3a72f'
            : hasReport
              ? '#00e599'
              : '#94a3b8';

      dCtx.fillStyle = '#04070a';
      dCtx.fillRect(0, 0, 512, 256);

      dCtx.strokeStyle = isCritical
        ? 'rgba(249,115,22,0.65)'
        : isCaution
          ? 'rgba(227,167,47,0.5)'
          : 'rgba(255,255,255,0.08)';
      dCtx.lineWidth = isCritical ? 3 : 2;
      dCtx.strokeRect(10, 10, 492, 236);

      const mountTag = curMount.toUpperCase();
      const headerTitle = diagnosing
        ? 'DIAGNOSTIC SCAN'
        : curWorker
          ? `[${mountTag}] ${curWorker.id}`
          : `[${mountTag}] PUCK MK-IV`;

      dCtx.fillStyle = hasReport || diagnosing || isDisc ? signalColor : curFinish.accentHex;
      dCtx.font = 'bold 20px "JetBrains Mono", monospace';
      dCtx.fillText(headerTitle.slice(0, 22), 28, 44);

      const statusBadge = isDisc
        ? 'DISC FAIL'
        : curWorker?.mq3Status === 'flagged'
          ? 'ALC FLAG'
          : !curWorker
            ? 'UNLINKED'
            : !hasReport
              ? 'AWAITING'
              : isCritical
                ? 'CRITICAL'
                : isCaution
                  ? 'CAUTION'
                  : streamUp
                    ? 'LIVE OK'
                    : 'SYNCED';

      dCtx.fillStyle = hasReport || isDisc ? signalColor : '#94a3b8';
      dCtx.font = 'bold 18px "JetBrains Mono", monospace';
      dCtx.fillText(statusBadge, 366, 44);

      // Waveform or Disconnect Warning
      dCtx.strokeStyle = signalColor;
      dCtx.lineWidth = hasReport && !isDisc ? 5 : 2.5;
      dCtx.beginPath();
      const waveY = 136;
      for (let i = 0; i <= 80; i++) {
        const u = i / 80;
        const x = 28 + u * 456;
        let y = waveY;
        if (hasReport && !isDisc) {
          const phase = (u * 2.1 - elapsed * (curBpm / 60)) % 1;
          const cyc = phase < 0 ? phase + 1 : phase;
          const spike =
            Math.exp(-Math.pow((cyc - 0.35) / 0.025, 2)) * -52 +
            Math.exp(-Math.pow((cyc - 0.42) / 0.03, 2)) * 24 -
            Math.exp(-Math.pow((cyc - 0.56) / 0.055, 2)) * 14;
          y = waveY + spike;
        }
        if (i === 0) dCtx.moveTo(x, y);
        else dCtx.lineTo(x, y);
      }
      dCtx.stroke();

      if (isDisc) {
        dCtx.fillStyle = '#f97316';
        dCtx.font = 'bold 24px "JetBrains Mono", monospace';
        dCtx.fillText('MECHANICAL FAIL / LEAD-OFF', 28, 212);
      } else if (hasReport) {
        dCtx.fillStyle = '#f8fafc';
        dCtx.font = 'bold 46px "Plus Jakarta Sans", sans-serif';
        dCtx.fillText(String(curBpm), 28, 220);

        const lim = curWorker?.dynamicHrR ?? 140;
        const rf = curWorker?.riskFactor ?? 1.0;
        dCtx.fillStyle = signalColor;
        dCtx.font = 'bold 18px "JetBrains Mono", monospace';
        dCtx.fillText(
          `BPM • ${curTemp.toFixed(1)}°C • LIM ${lim} (Rf ${rf.toFixed(2)})`,
          112,
          215,
        );
      } else {
        dCtx.fillStyle = '#e2e8f0';
        dCtx.font = 'bold 21px "Plus Jakarta Sans", sans-serif';
        dCtx.fillText(
          curWorker ? 'Awaiting real band packet' : 'Pair worker band to stream',
          28,
          216,
        );
      }

      displayTex.needsUpdate = true;
    };

    updateOled(0);

    const displayPlate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.36),
      new THREE.MeshBasicMaterial({
        map: displayTex,
        transparent: true,
        opacity: 0.96,
      }),
    );
    displayPlate.position.z = 0.118;
    coreGroup.add(displayPlate);

    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b121a,
      roughness: 0.04,
      metalness: 0.08,
      transmission: isSoftwareGl ? 0 : 0.72,
      transparent: true,
      opacity: isSoftwareGl ? 0.28 : 0.94,
      ior: 1.77,
      thickness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      depthWrite: false,
    });
    const screenMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.39, 0.025),
      glassMat,
    );
    screenMesh.position.z = 0.135;
    screenMesh.renderOrder = 2;
    coreGroup.add(screenMesh);

    // Underside Optical PPG & Skin Thermistor Array
    const sensorGroup = new THREE.Group();
    sensorGroup.position.z = -0.1;
    coreGroup.add(sensorGroup);

    const sensorRing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.185, 0.205, 0.045, 32),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.25,
        metalness: 0.85,
      }),
    );
    sensorRing.rotation.x = Math.PI / 2;
    sensorGroup.add(sensorRing);

    const ppgPcbGeo = new THREE.CircleGeometry(0.122, 32);
    const ppgPcbMat = new THREE.MeshStandardMaterial({
      color: 0x064e3b,
      roughness: 0.35,
      metalness: 0.45,
      emissive: 0x059669,
      emissiveIntensity: 0.15,
    });
    const ppgPcbMesh = new THREE.Mesh(ppgPcbGeo, ppgPcbMat);
    ppgPcbMesh.rotation.y = Math.PI;
    ppgPcbMesh.position.z = -0.0235;
    sensorGroup.add(ppgPcbMesh);

    const thermistorMat = new THREE.MeshStandardMaterial({
      color: 0xe3a72f,
      roughness: 0.22,
      metalness: 0.92,
      emissive: 0xe3a72f,
      emissiveIntensity: 0.1,
    });
    const thermistorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.125, 0.16, 32),
      thermistorMat,
    );
    thermistorRing.rotation.y = Math.PI;
    thermistorRing.position.z = -0.025;
    sensorGroup.add(thermistorRing);

    const sensorGlowMat = new THREE.MeshBasicMaterial({ color: 0x00e599 });
    const sensorLedCenter = new THREE.Mesh(
      new THREE.CircleGeometry(0.055, 24),
      sensorGlowMat,
    );
    sensorLedCenter.rotation.y = Math.PI;
    sensorLedCenter.position.z = -0.026;
    sensorGroup.add(sensorLedCenter);

    const flankMat = new THREE.MeshBasicMaterial({ color: 0xe3a72f });
    const flankL = new THREE.Mesh(new THREE.CircleGeometry(0.028, 16), flankMat);
    flankL.rotation.y = Math.PI;
    flankL.position.set(-0.092, 0, -0.026);
    sensorGroup.add(flankL);

    const flankR = flankL.clone();
    flankR.position.set(0.092, 0, -0.026);
    sensorGroup.add(flankR);

    // Highlight Halo Rings for PPG Array focus
    const ppgHaloGroup = new THREE.Group();
    ppgHaloGroup.position.z = -0.032;
    ppgHaloGroup.rotation.y = Math.PI;
    ppgHaloGroup.visible = false;
    sensorGroup.add(ppgHaloGroup);

    const ppgHaloInnerGeo = new THREE.RingGeometry(0.205, 0.232, 36);
    const ppgHaloInnerMat = new THREE.MeshBasicMaterial({
      color: 0x00e599,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ppgHaloInner = new THREE.Mesh(ppgHaloInnerGeo, ppgHaloInnerMat);
    ppgHaloGroup.add(ppgHaloInner);

    const ppgHaloOuterGeo = new THREE.RingGeometry(0.258, 0.282, 36);
    const ppgHaloOuterMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ppgHaloOuter = new THREE.Mesh(ppgHaloOuterGeo, ppgHaloOuterMat);
    ppgHaloGroup.add(ppgHaloOuter);

    // Mount Hardware Focus Halo
    const mountHaloGeo = new THREE.TorusGeometry(0.36, 0.018, 12, 36);
    const mountHaloMat = new THREE.MeshBasicMaterial({
      color: 0xe3a72f,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const mountHaloMesh = new THREE.Mesh(mountHaloGeo, mountHaloMat);
    mountHaloMesh.visible = false;
    bandGroup.add(mountHaloMesh);

    bandGroup.rotation.set(0.16, -0.42, 0.06);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 380;
      const h = container.clientHeight || 380;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    let frameId = 0;
    let isDisposed = false;
    let explodeFactor = 0;
    let lastOledUpdate = -1;
    const clock = new THREE.Clock();

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (isDisposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (sync && state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (isDisposed) return;
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.getElapsedTime();
      const cur = stateRef.current;

      // Visibility per Mount Mode
      wristMountGroup.visible = cur.mountMode === 'wrist';
      bicepMountGroup.visible = cur.mountMode === 'bicep';
      helmetMountGroup.visible = cur.mountMode === 'helmet';

      bandMat.color.setHex(cur.finish.bandColor);
      bandMat.roughness = cur.finish.bandRoughness;
      bandMat.metalness = cur.finish.bandMetalness;

      chassisMat.color.setHex(cur.finish.chassisColor);
      chassisMat.roughness = cur.finish.chassisRoughness;
      chassisMat.metalness = cur.finish.chassisMetalness;

      claspMat.color.setHex(cur.finish.claspColor);
      claspMat.roughness = cur.finish.claspRoughness;
      claspMat.metalness = cur.finish.claspMetalness;

      pottingRingMat.color.setHex(
        cur.keepAliveStatus.state === 'disconnected' ? 0xf97316 : 0x00e599,
      );

      // Exploded separation + automatic slight lift when inspecting underside PPG or side Breath Vent
      const targetExplode = cur.exploded
        ? 1
        : cur.preset === 'sensor'
          ? 0.62
          : cur.preset === 'breath'
            ? 0.38
            : 0;
      explodeFactor = THREE.MathUtils.damp(explodeFactor, targetExplode, 7, delta);

      if (cur.mountMode === 'helmet') {
        coreGroup.position.set(0, 0.44, 1.66 + explodeFactor * 0.56);
        coreGroup.rotation.set(0, 0, 0);
      } else if (cur.mountMode === 'bicep') {
        coreGroup.position.set(0, 1.36 + explodeFactor * 0.52, 0);
        coreGroup.rotation.set(-Math.PI / 2, 0, 0);
      } else {
        coreGroup.position.set(0, 1.13 + explodeFactor * 0.48, 0);
        coreGroup.rotation.set(-Math.PI / 2, 0, 0);
      }

      screenMesh.position.z = 0.135 + explodeFactor * 0.42;
      displayPlate.position.z = 0.118 + explodeFactor * 0.24;
      bezelMesh.position.z = 0.096 + explodeFactor * 0.12;
      pottingRing.position.z = -0.05 - explodeFactor * 0.14;
      sensorGroup.position.z = -0.1 - explodeFactor * 0.34;
      breathAssembly.position.x = 0.47 + explodeFactor * 0.28;
      const isBreathFocus = cur.preset === 'breath';
      const capOpen = isBreathFocus ? 0.09 : explodeFactor * 0.08;
      ventCollar.position.x = capOpen;
      eptfeMembrane.position.x = capOpen;
      ventRing.position.x = 0.023 + capOpen;
      memsDie.position.x = -0.036 - explodeFactor * 0.06;
      memsPcb.position.x = -0.056 - explodeFactor * 0.08;
      memsWindow.position.x = -0.02 - explodeFactor * 0.06;
      wakeBtn.position.x = -0.48 - explodeFactor * 0.14;
      imuChip.position.x = -0.43 - explodeFactor * 0.04;
      claspGroup.position.y = -1.12 - explodeFactor * 0.26;

      ventRingMat.color.setHex(
        cur.worker?.mq3Status === 'flagged'
          ? 0xf97316
          : cur.worker?.mq3Status === 'clear'
            ? 0x00e599
            : 0x38bdf8,
      );

      // Part Highlighting & Animated Focus Halos
      const isSensorFocus = cur.preset === 'sensor';
      const isClaspFocus = cur.preset === 'clasp';
      const isProfileFocus = cur.preset === 'profile';
      const haloWave = (Math.sin(elapsed * 4.2) + 1) * 0.5;

      ppgHaloGroup.visible = isSensorFocus;
      if (isSensorFocus) {
        const s = 1 + haloWave * 0.14;
        ppgHaloOuter.scale.set(s, s, 1);
        ppgHaloOuterMat.opacity = 0.85 - haloWave * 0.55;
        ppgHaloInnerMat.opacity = 0.72 + haloWave * 0.28;
      }
      thermistorMat.emissiveIntensity = isSensorFocus ? 0.55 + haloWave * 0.45 : 0.08;
      ppgPcbMat.emissiveIntensity = isSensorFocus ? 0.42 + haloWave * 0.3 : 0.12;

      breathHaloGroup.visible = isBreathFocus;
      breathHaloGroup.position.x = 0.032 + capOpen;
      if (isBreathFocus) {
        const breathCycle = (elapsed * 1.15) % 1;
        const ws = 1 + breathCycle * 0.48;
        breathHaloWave.scale.set(ws, ws, 1);
        breathHaloWaveMat.opacity = (1 - breathCycle) * 0.88;
        breathHaloInnerMat.opacity = 0.78 + haloWave * 0.22;
      }
      ventCollarMat.emissiveIntensity = isBreathFocus ? 0.45 + haloWave * 0.35 : 0;
      eptfeMembraneMat.emissiveIntensity = isBreathFocus ? 0.65 + haloWave * 0.4 : 0;
      memsDieMat.emissiveIntensity = isBreathFocus ? 0.85 + haloWave * 0.45 : 0.12;
      memsPcbMat.emissiveIntensity = isBreathFocus ? 0.5 + haloWave * 0.35 : 0.1;
      imuChipMat.emissiveIntensity = isProfileFocus ? 0.75 + haloWave * 0.45 : 0.12;

      mountHaloMesh.visible = isClaspFocus;
      if (isClaspFocus) {
        if (cur.mountMode === 'helmet') {
          mountHaloMesh.position.set(0, 0.44, 1.56);
          mountHaloMesh.rotation.set(0, 0, 0);
        } else if (cur.mountMode === 'bicep') {
          mountHaloMesh.position.set(0, 1.32, 0);
          mountHaloMesh.rotation.set(Math.PI / 2, 0, 0);
        } else {
          mountHaloMesh.position.copy(claspGroup.position);
          mountHaloMesh.rotation.set(Math.PI / 2, 0, 0);
        }
        const ms = 1 + haloWave * 0.08;
        mountHaloMesh.scale.set(ms, ms, 1);
        mountHaloMat.opacity = 0.6 + haloWave * 0.38;
      }

      bandGroup.updateMatrixWorld(true);

      // Focus PointLight illuminates whichever part is highlighted
      if (isSensorFocus) {
        sensorGroup.getWorldPosition(_partPos);
        sensorGroup.getWorldQuaternion(_partQuat);
        _normalVec.set(0, 0, -1).applyQuaternion(_partQuat).normalize();
        focusLight.color.setHex(0x00e599);
        focusLight.intensity = 3.4;
        focusLight.position.copy(_partPos).addScaledVector(_normalVec, 0.85);
      } else if (isBreathFocus) {
        breathAssembly.getWorldPosition(_partPos);
        breathAssembly.getWorldQuaternion(_partQuat);
        _normalVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
        focusLight.color.setHex(0x38bdf8);
        focusLight.intensity = 3.6;
        focusLight.position.copy(_partPos).addScaledVector(_normalVec, 0.85);
      } else if (isClaspFocus) {
        mountHaloMesh.getWorldPosition(_partPos);
        focusLight.color.setHex(0xe3a72f);
        focusLight.intensity = 3.0;
        focusLight.position.copy(_partPos).add(new THREE.Vector3(0.4, -0.4, 1.0));
      } else {
        focusLight.intensity = 0;
      }

      if (cur.presetTransitionActive) {
        if (cur.preset === 'sensor') {
          sensorGroup.getWorldPosition(_targetCtrl);
          sensorGroup.getWorldQuaternion(_partQuat);
          _normalVec.set(0, 0, -1).applyQuaternion(_partQuat).normalize();
          _sideVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
          _upVec.set(0, 1, 0).applyQuaternion(_partQuat).normalize();
          _targetCamPos
            .copy(_targetCtrl)
            .addScaledVector(_normalVec, 1.95)
            .addScaledVector(_sideVec, 0.52)
            .addScaledVector(_upVec, -0.32);
        } else if (cur.preset === 'breath') {
          breathAssembly.getWorldPosition(_targetCtrl);
          breathAssembly.getWorldQuaternion(_partQuat);
          _normalVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
          _upVec.set(0, 0, 1).applyQuaternion(_partQuat).normalize();
          _sideVec.set(0, 1, 0).applyQuaternion(_partQuat).normalize();
          _targetCamPos
            .copy(_targetCtrl)
            .addScaledVector(_normalVec, 1.78)
            .addScaledVector(_upVec, 0.62)
            .addScaledVector(_sideVec, 0.25);
        } else if (cur.preset === 'clasp') {
          if (cur.mountMode === 'helmet') {
            clipBracket.getWorldPosition(_targetCtrl);
            clipBracket.getWorldQuaternion(_partQuat);
            _normalVec.set(0, 0, 1).applyQuaternion(_partQuat).normalize();
            _sideVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
            _upVec.set(0, 1, 0).applyQuaternion(_partQuat).normalize();
            _targetCamPos
              .copy(_targetCtrl)
              .addScaledVector(_normalVec, 2.2)
              .addScaledVector(_sideVec, 0.75)
              .addScaledVector(_upVec, 0.45);
          } else if (cur.mountMode === 'bicep') {
            bicepCradle.getWorldPosition(_targetCtrl);
            bicepCradle.getWorldQuaternion(_partQuat);
            _normalVec.set(0, 0, 1).applyQuaternion(_partQuat).normalize();
            _sideVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
            _upVec.set(0, 1, 0).applyQuaternion(_partQuat).normalize();
            _targetCamPos
              .copy(_targetCtrl)
              .addScaledVector(_normalVec, 1.95)
              .addScaledVector(_sideVec, 1.15)
              .addScaledVector(_upVec, 0.75);
          } else {
            claspGroup.getWorldPosition(_targetCtrl);
            claspGroup.getWorldQuaternion(_partQuat);
            _normalVec.set(0, 0, 1).applyQuaternion(_partQuat).normalize();
            _sideVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
            _upVec.set(0, 1, 0).applyQuaternion(_partQuat).normalize();
            _targetCamPos
              .copy(_targetCtrl)
              .addScaledVector(_normalVec, 2.1)
              .addScaledVector(_sideVec, 1.1)
              .addScaledVector(_upVec, -0.75);
          }
        } else if (cur.preset === 'profile') {
          coreGroup.getWorldPosition(_targetCtrl);
          coreGroup.getWorldQuaternion(_partQuat);
          _normalVec.set(1, 0, 0).applyQuaternion(_partQuat).normalize();
          _upVec.set(0, 0, 1).applyQuaternion(_partQuat).normalize();
          _targetCamPos
            .copy(_targetCtrl)
            .addScaledVector(_normalVec, 2.8)
            .addScaledVector(_upVec, 1.25);
        } else {
          const targetPreset = CAMERA_PRESETS[cur.preset];
          _targetCamPos.set(...targetPreset.pos);
          _targetCtrl.set(...targetPreset.target);
        }

        const lerpAlpha = 1 - Math.exp(-6.0 * delta);
        camera.position.lerp(_targetCamPos, lerpAlpha);
        controls.target.lerp(_targetCtrl, lerpAlpha);
        if (camera.position.distanceTo(_targetCamPos) < 0.025) {
          cur.presetTransitionActive = false;
        }
      }

      if (cur.autoOrbit && !cur.presetTransitionActive) {
        bandGroup.rotation.y += delta * 0.26;
      }
      bandGroup.position.y = Math.sin(elapsed * 1.4) * 0.04;

      const isDisc = cur.keepAliveStatus.state === 'disconnected';
      const hasReport = cur.bpm !== null && cur.bpm > 0 && !isDisc;
      const pulseSpeed = cur.isDiagnosing
        ? 8.5
        : isDisc
          ? 6.0
          : hasReport
            ? ((cur.bpm as number) / 60) * Math.PI * 2
            : 0;
      const pulse =
        cur.isDiagnosing || hasReport || isDisc || isSensorFocus
          ? (Math.sin(elapsed * (pulseSpeed || 5.5)) + 1) * 0.5
          : 0.08;
      const hue = cur.isDiagnosing
        ? 0.54
        : isDisc || cur.condition === 'critical'
          ? 0.05
          : cur.condition === 'caution'
            ? 0.11
            : 0.43;
      sensorGlowMat.color.setHSL(
        hue,
        hasReport || cur.isDiagnosing || isDisc || isSensorFocus ? 1.0 : 0.25,
        (isSensorFocus ? 0.36 : 0.22) + pulse * 0.36,
      );

      if (elapsed - lastOledUpdate > 0.066) {
        lastOledUpdate = elapsed;
        updateOled(elapsed);
      }

      controls.update();
      renderer.render(scene, camera);

      // Project highlighted 3D sensor anchor onto 2D DOM leader pin
      if (
        cur.preset !== 'hero' &&
        pinCardRef.current &&
        pinDotRef.current &&
        pinRingRef.current &&
        pinLineRef.current
      ) {
        const vw = container.clientWidth || 380;
        const vh = container.clientHeight || 380;
        if (cur.preset === 'sensor') {
          sensorGroup.getWorldPosition(_projVec);
        } else if (cur.preset === 'breath') {
          memsDie.getWorldPosition(_projVec);
        } else if (cur.preset === 'clasp') {
          mountHaloMesh.getWorldPosition(_projVec);
        } else {
          wakeBtn.getWorldPosition(_projVec);
        }
        _projVec.project(camera);
        const dotX = Math.max(24, Math.min(vw - 24, (_projVec.x * 0.5 + 0.5) * vw));
        const dotY = Math.max(54, Math.min(vh - 132, (-_projVec.y * 0.5 + 0.5) * vh));

        const cardW = pinCardRef.current.offsetWidth || 240;
        const cardH = pinCardRef.current.offsetHeight || 52;
        const placeLeft = dotX > vw * 0.52;
        const cardX = Math.max(
          14,
          Math.min(vw - cardW - 14, placeLeft ? 14 : vw - cardW - 14),
        );
        const cardY = 52;
        const lineEndX = placeLeft ? cardX + cardW : cardX;
        const lineEndY = cardY + cardH * 0.5;

        pinCardRef.current.style.transform = `translate3d(${cardX}px, ${cardY}px, 0)`;
        pinDotRef.current.setAttribute('cx', dotX.toFixed(1));
        pinDotRef.current.setAttribute('cy', dotY.toFixed(1));
        pinRingRef.current.setAttribute('cx', dotX.toFixed(1));
        pinRingRef.current.setAttribute('cy', dotY.toFixed(1));
        pinLineRef.current.setAttribute('x1', lineEndX.toFixed(1));
        pinLineRef.current.setAttribute('y1', lineEndY.toFixed(1));
        pinLineRef.current.setAttribute('x2', dotX.toFixed(1));
        pinLineRef.current.setAttribute('y2', dotY.toFixed(1));
      }

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    if (isSoftwareGl) {
      renderer.render(scene, camera);
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);

      controls.dispose();
      wristGeo.dispose();
      claspMainGeo.dispose();
      claspTrimGeo.dispose();
      bicepGeo.dispose();
      bicepBuckleGeo.dispose();
      bicepCradleGeo.dispose();
      helmetDomeGeo.dispose();
      crestGeo.dispose();
      brimGeo.dispose();
      linerGeo.dispose();
      clipBracketGeo.dispose();
      coreCaseGeo.dispose();
      pottingRingGeo.dispose();
      bezelGeo.dispose();
      ventCollarGeo.dispose();
      eptfeMembraneGeo.dispose();
      ventRingGeo.dispose();
      memsPcbGeo.dispose();
      memsDieGeo.dispose();
      memsWindowGeo.dispose();
      breathHaloInnerGeo.dispose();
      breathHaloWaveGeo.dispose();
      wakeBtnGeo.dispose();
      imuChipGeo.dispose();
      screenMesh.geometry.dispose();
      displayPlate.geometry.dispose();
      sensorRing.geometry.dispose();
      ppgPcbGeo.dispose();
      thermistorRing.geometry.dispose();
      sensorLedCenter.geometry.dispose();
      flankL.geometry.dispose();
      ppgHaloInnerGeo.dispose();
      ppgHaloOuterGeo.dispose();
      mountHaloGeo.dispose();
      contactShadow.geometry.dispose();

      bandMat.dispose();
      bicepBandMat.dispose();
      helmetShellMat.dispose();
      linerMat.dispose();
      cradleMat.dispose();
      chassisMat.dispose();
      pottingRingMat.dispose();
      ventCollarMat.dispose();
      eptfeMembraneMat.dispose();
      ventRingMat.dispose();
      memsPcbMat.dispose();
      memsDieMat.dispose();
      memsWindowMat.dispose();
      breathHaloInnerMat.dispose();
      breathHaloWaveMat.dispose();
      imuChipMat.dispose();
      claspMat.dispose();
      claspRingMat.dispose();
      glassMat.dispose();
      (displayPlate.material as THREE.Material).dispose();
      (sensorRing.material as THREE.Material).dispose();
      ppgPcbMat.dispose();
      thermistorMat.dispose();
      sensorGlowMat.dispose();
      flankMat.dispose();
      ppgHaloInnerMat.dispose();
      ppgHaloOuterMat.dispose();
      mountHaloMat.dispose();
      (contactShadow.material as THREE.Material).dispose();

      bumpTex.dispose();
      displayTex.dispose();
      shadowTex.dispose();
      envTex.dispose();
      renderer.dispose();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  const currentMountSpec =
    MOUNT_OPTIONS.find((m) => m.id === mountMode) ?? MOUNT_OPTIONS[0];
  const activeSensorInfo = getPresetSensorInfo(activePreset, mountMode);
  const activePresetMeta = CAMERA_PRESETS[activePreset];

  return (
    <div className="relative w-full h-[400px] sm:h-[440px] lg:h-[470px] bg-gradient-to-b from-obsidian-900 via-obsidian-850 to-obsidian-950 overflow-hidden select-none">
      {/* Ambient Radial Accents */}
      <div className="pointer-events-none absolute -top-14 -left-14 w-48 h-48 rounded-full bg-emeraldGlow/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-12 -right-12 w-52 h-52 rounded-full bg-titaniumGold/10 blur-3xl" />

      {/* Top Stage Indicators */}
      <div className="absolute top-3.5 left-3.5 right-3.5 z-20 flex items-center justify-between gap-2 pointer-events-none">
        <div className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-medium text-slate-200 bg-[#070b0e]/90 border border-white/10">
          <View className="w-3.5 h-3.5 text-titaniumGold" aria-hidden="true" />
          <span>IK07 Modular Puck · {currentMountSpec.shortLabel}</span>
        </div>

        <button
          type="button"
          onClick={() => setAutoOrbit((prev) => !prev)}
          className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono uppercase tracking-wide text-slate-200 bg-[#070b0e]/90 border border-white/10 hover:border-emeraldGlow/40 transition-colors cursor-pointer"
        >
          {autoOrbit ? (
            <RotateCw className="w-3 h-3 text-emeraldGlow" aria-hidden="true" />
          ) : (
            <RotateCcw className="w-3 h-3 text-slate-400" aria-hidden="true" />
          )}
          <span>{autoOrbit ? 'Kinetic Orbit On' : 'Manual Orbit'}</span>
        </button>
      </div>

      {/* Live 3D-Projected Hardware / Sensor Callout Leader Pin */}
      {!webglError && activePreset !== 'hero' && (
        <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          <svg className="w-full h-full" aria-hidden="true">
            <line
              ref={pinLineRef}
              x1="0"
              y1="0"
              x2="0"
              y2="0"
              stroke={activePresetMeta.accentHex}
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeOpacity="0.85"
            />
            <circle
              ref={pinRingRef}
              cx="0"
              cy="0"
              r="9"
              fill="none"
              stroke={activePresetMeta.accentHex}
              strokeWidth="1.5"
              strokeOpacity="0.55"
            />
            <circle
              ref={pinDotRef}
              cx="0"
              cy="0"
              r="4"
              fill={activePresetMeta.accentHex}
            />
          </svg>

          <div
            ref={pinCardRef}
            className="absolute top-0 left-0 max-w-[260px] px-3 py-2 rounded-xl bg-[#070b0e]/92 backdrop-blur-sm border border-white/15 shadow-xl"
            style={{ transform: 'translate3d(14px, 52px, 0)' }}
          >
            <p className="text-[9px] font-mono tracking-wider text-slate-400 uppercase">
              Active Sensor · {activePresetMeta.label}
            </p>
            <p className={`text-[11px] font-mono font-semibold leading-tight mt-0.5 ${activePresetMeta.accentClass}`}>
              {activeSensorInfo.device}
            </p>
            <p className="text-[10px] text-slate-300 leading-snug mt-0.5">
              {activeSensorInfo.spec}
            </p>
          </div>
        </div>
      )}

      {/* Isolated WebGL Canvas Mount */}
      {!webglError ? (
        <div
          ref={mountRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          aria-label="Interactive 3D JaanBand Core MK-IV modular puck"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center px-6 text-center">
          <div className="w-24 h-24 rounded-full border-4 border-emeraldGlow/40 bg-obsidian-800 flex items-center justify-center mb-3">
            <View className="w-9 h-9 text-emeraldGlow" />
          </div>
          <p className="text-sm font-semibold text-white">JaanBand Core MK-IV</p>
          <p className="text-xs text-slate-400 mt-1 max-w-xs">
            {currentMountSpec.label} — {currentMountSpec.spec}
          </p>
        </div>
      )}

      {/* Collapsible Bottom Control Dock (Mount Switcher + Camera + Explode) */}
      <div className="absolute bottom-3 left-3 right-3 z-20 flex flex-col items-center gap-1.5 pointer-events-none">

        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-[#070b0e]/92 border border-white/10 p-1 shadow-lg">
          {MOUNT_OPTIONS.map((opt) => {
            const active = mountMode === opt.id;
            const Icon =
              opt.id === 'helmet'
                ? HardHat
                : opt.id === 'bicep'
                  ? Shield
                  : Watch;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeMountMode(opt.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono transition-colors cursor-pointer ${
                  active
                    ? 'bg-titaniumGold/20 text-titaniumGold border border-titaniumGold/40'
                    : 'text-slate-300 hover:text-white border border-transparent'
                }`}
                title={opt.spec}
              >
                <Icon className="w-3 h-3" aria-hidden="true" />
                <span>{opt.shortLabel}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setHudCollapsed((c) => !c)}
          className="pointer-events-auto inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#070b0e]/90 border border-white/10 text-[10px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
          aria-expanded={!hudCollapsed}
        >
          {hudCollapsed ? (
            <>
              <ChevronUp className="w-3 h-3" aria-hidden="true" />
              <span>Studio Controls</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" aria-hidden="true" />
              <span>Hide Controls</span>
            </>
          )}
        </button>

        {!hudCollapsed && (
          <div className="pointer-events-auto w-full max-w-[468px] rounded-2xl bg-[#070b0e]/92 border border-white/10 p-1.5 flex items-center justify-between gap-1.5 shadow-xl">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {(Object.keys(CAMERA_PRESETS) as CameraPreset[]).map((presetKey) => {
                const isActive = activePreset === presetKey;
                return (
                  <button
                    key={presetKey}
                    type="button"
                    onClick={() => triggerPreset(presetKey)}
                    className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-emeraldGlow/15 text-emeraldGlow border border-emeraldGlow/35'
                        : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    {CAMERA_PRESETS[presetKey].label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={onToggleExploded}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-mono whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                exploded
                  ? 'bg-titaniumGold/20 text-titaniumGold border border-titaniumGold/40'
                  : 'bg-obsidian-800 text-slate-200 border border-white/10 hover:border-white/20'
              }`}
              title="Pop out core puck & inspect conformal potting layers"
            >
              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{exploded ? 'Seat Puck' : 'Pop Puck'}</span>
            </button>
          </div>
        )}

        {hudCollapsed && (
          <div className="pointer-events-none px-3 py-1 rounded-full bg-[#070b0e]/85 border border-white/10 flex items-center gap-1.5">
            <Touchpad className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            <span className="text-[10px] font-mono tracking-wider text-slate-300 uppercase">
              Drag to Orbit &amp; Inspect
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
