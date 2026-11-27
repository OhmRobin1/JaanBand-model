import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {
  ChevronDown,
  ChevronUp,
  Layers,
  RotateCcw,
  RotateCw,
  Touchpad,
  View,
} from 'lucide-react';
import {
  CameraPreset,
  ConditionLevel,
  FinishOption,
  WorkerRecord,
} from '../types/band';

interface BandViewport3DProps {
  finish: FinishOption;
  worker: WorkerRecord | null;
  condition: ConditionLevel;
  bpm: number | null;
  skinTempC: number | null;
  isConnectedStream: boolean;
  isDiagnosing: boolean;
  exploded: boolean;
  onToggleExploded: () => void;
}

const CAMERA_PRESETS: Record<
  CameraPreset,
  { label: string; pos: [number, number, number]; target: [number, number, number] }
> = {
  hero: { label: 'Studio', pos: [0.45, 2.15, 4.35], target: [0, 0.08, 0] },
  sensor: { label: 'PPG Array', pos: [0.55, -0.55, 2.75], target: [0, 0.96, 0] },
  clasp: { label: 'Ti Clasp', pos: [1.55, -1.65, 2.75], target: [0, -1.04, 0] },
  profile: { label: 'Profile', pos: [3.85, 0.65, 1.35], target: [0, 0.08, 0] },
};

const _targetCamPos = new THREE.Vector3();
const _targetCtrl = new THREE.Vector3();

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
  condition,
  bpm,
  skinTempC,
  isConnectedStream,
  isDiagnosing,
  exploded,
  onToggleExploded,
}: BandViewport3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [autoOrbit, setAutoOrbit] = useState(true);
  const [activePreset, setActivePreset] = useState<CameraPreset>('hero');
  const [hudCollapsed, setHudCollapsed] = useState(false);
  const [webglError, setWebglError] = useState(false);

  const stateRef = useRef({
    finish,
    worker,
    condition,
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
  stateRef.current.condition = condition;
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
  };

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
    scene.fog = new THREE.FogExp2(0x070b0e, 0.045);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(...CAMERA_PRESETS.hero.pos);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 2.8;
    controls.maxDistance = 7.5;
    controls.target.set(...CAMERA_PRESETS.hero.target);

    controls.addEventListener('start', () => {
      stateRef.current.presetTransitionActive = false;
    });

    // Studio reflection environment
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTex = pmremGenerator.fromScene(roomEnv, 0.04).texture;
    scene.environment = envTex;
    roomEnv.dispose();
    pmremGenerator.dispose();

    // Balanced warm/cool 3-point lighting rig
    const hemiLight = new THREE.HemisphereLight(0xcbe7ff, 0x101820, 0.75);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff6e8, 2.2);
    keyLight.position.set(4, 5.5, 4.5);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 16;
      keyLight.shadow.camera.left = -2.5;
      keyLight.shadow.camera.right = 2.5;
      keyLight.shadow.camera.top = 2.5;
      keyLight.shadow.camera.bottom = -2.5;
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

    const goldWarmLight = new THREE.PointLight(0xe3a72f, 1.1, 10);
    goldWarmLight.position.set(2.2, -2.0, 2.2);
    scene.add(goldWarmLight);

    if (!isSoftwareGl) {
      RectAreaLightUniformsLib.init();
      const topSoftbox = new THREE.RectAreaLight(0xffffff, 2.8, 3.5, 1.4);
      topSoftbox.position.set(0, 3.4, 1.6);
      topSoftbox.lookAt(0, 0.3, 0);
      scene.add(topSoftbox);
    }

    // Contact shadow plane beneath the band for physical grounding
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
      new THREE.PlaneGeometry(4.4, 2.8),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.65,
      }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = -1.62;
    scene.add(contactShadow);

    // Master Group
    const bandGroup = new THREE.Group();
    scene.add(bandGroup);

    // Procedural micro-groove bump texture for fluoro-elastomer strap
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

    // 1. Ergonomic curved strap loop (wide along Z across the forearm, thin radially against skin)
    const rx = 1.54;
    const ry = 1.12;
    class BandCurve extends THREE.Curve<THREE.Vector3> {
      constructor() {
        super();
      }
      getPoint(t: number, optionalTarget = new THREE.Vector3()) {
        const angle = 2 * Math.PI * t;
        const x = Math.sin(angle) * rx;
        const y = Math.cos(angle) * ry;
        return optionalTarget.set(x, y, 0);
      }
    }
    const bandGeo = new THREE.TubeGeometry(new BandCurve(), 180, 0.24, 28, true);
    const pos = bandGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const theta = Math.atan2(vx / rx, vy / ry);
      const cx = Math.sin(theta) * rx;
      const cy = Math.cos(theta) * ry;
      pos.setX(i, cx + (vx - cx) * 0.36);
      pos.setY(i, cy + (vy - cy) * 0.36);
    }
    bandGeo.computeVertexNormals();

    const bandMat = new THREE.MeshStandardMaterial({
      color: finish.bandColor,
      roughness: finish.bandRoughness,
      metalness: finish.bandMetalness,
      bumpMap: bumpTex,
      bumpScale: 0.016,
    });
    const bandMesh = new THREE.Mesh(bandGeo, bandMat);
    bandMesh.castShadow = true;
    bandMesh.receiveShadow = true;
    bandGroup.add(bandMesh);

    // 2. Grade 5 Titanium Clasp Sleeve & Trim Collars (wraps flush around bottom strap)
    const claspGroup = new THREE.Group();
    const claspMat = new THREE.MeshPhysicalMaterial({
      color: finish.claspColor,
      roughness: finish.claspRoughness,
      metalness: finish.claspMetalness,
      anisotropy: 0.8,
      clearcoat: 0.25,
    });
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

    const claspRingMat = new THREE.MeshStandardMaterial({
      color: 0x0b0e12,
      roughness: 0.3,
      metalness: 0.7,
    });
    const claspTrimGeo = new THREE.BoxGeometry(0.022, 0.215, 0.515);
    const claspTrimL = new THREE.Mesh(claspTrimGeo, claspRingMat);
    claspTrimL.position.x = -0.145;
    claspGroup.add(claspTrimL);

    const claspTrimR = claspTrimL.clone();
    claspTrimR.position.x = 0.145;
    claspGroup.add(claspTrimR);

    claspGroup.position.set(0, -1.12, 0);
    bandGroup.add(claspGroup);

    // 3. Central Core Housing — Oriented horizontally tangent to the top of the wrist
    // Local +Z maps to World +Y (OLED & Sapphire glass facing outward)
    // Local -Z maps to World -Y (Optical PPG & thermistor array facing inward onto skin)
    const coreGroup = new THREE.Group();
    coreGroup.position.set(0, 1.13, 0);
    coreGroup.rotation.x = -Math.PI / 2;
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

    // 4. Titanium Bezel Frame (top outer face)
    const bezelGeo = new THREE.BoxGeometry(0.84, 0.43, 0.036);
    const bezelMesh = new THREE.Mesh(bezelGeo, claspMat);
    bezelMesh.position.z = 0.096;
    coreGroup.add(bezelMesh);

    // 5. Dynamic OLED Display CanvasTexture
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
        condition: curCondition,
        bpm: curBpm,
        skinTempC: curTemp,
        isConnectedStream: streamUp,
        isDiagnosing: diagnosing,
        finish: curFinish,
      } = stateRef.current;

      const hasReport = curBpm !== null && curTemp !== null;
      const isCritical = curCondition === 'critical';
      const isCaution = curCondition === 'caution';
      const signalColor = diagnosing
        ? '#38bdf8'
        : !hasReport
          ? '#94a3b8'
          : isCritical
            ? '#f97316'
            : isCaution
              ? '#e3a72f'
              : '#00e599';

      dCtx.fillStyle = '#04070a';
      dCtx.fillRect(0, 0, 512, 256);

      dCtx.strokeStyle = isCritical
        ? 'rgba(249,115,22,0.5)'
        : isCaution
          ? 'rgba(227,167,47,0.45)'
          : 'rgba(255,255,255,0.08)';
      dCtx.lineWidth = 2;
      dCtx.strokeRect(10, 10, 492, 236);

      const headerTitle = diagnosing
        ? 'DIAGNOSTIC SCAN'
        : curWorker
          ? `${curWorker.id} • ${curWorker.bandId || 'UNPAIRED'}`
          : 'JAANBAND MK-IV';

      dCtx.fillStyle = hasReport || diagnosing ? signalColor : curFinish.accentHex;
      dCtx.font = 'bold 20px "JetBrains Mono", monospace';
      dCtx.fillText(headerTitle.slice(0, 22), 28, 44);

      const statusBadge = !curWorker
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

      dCtx.fillStyle = hasReport ? signalColor : '#94a3b8';
      dCtx.font = '18px "JetBrains Mono", monospace';
      dCtx.fillText(statusBadge, 378, 44);

      // ECG / Arterial trace (flat line if awaiting real report)
      dCtx.strokeStyle = signalColor;
      dCtx.lineWidth = hasReport ? 5 : 2.5;
      dCtx.beginPath();
      const waveY = 144;
      for (let i = 0; i <= 80; i++) {
        const u = i / 80;
        const x = 28 + u * 456;
        let y = waveY;
        if (hasReport) {
          const phase = (u * 2.1 - elapsed * (curBpm / 60)) % 1;
          const cyc = phase < 0 ? phase + 1 : phase;
          const spike =
            Math.exp(-Math.pow((cyc - 0.35) / 0.025, 2)) * -56 +
            Math.exp(-Math.pow((cyc - 0.42) / 0.03, 2)) * 26 -
            Math.exp(-Math.pow((cyc - 0.56) / 0.055, 2)) * 15;
          y = waveY + spike;
        }
        if (i === 0) dCtx.moveTo(x, y);
        else dCtx.lineTo(x, y);
      }
      dCtx.stroke();

      if (hasReport) {
        dCtx.fillStyle = '#f8fafc';
        dCtx.font = 'bold 48px "Plus Jakarta Sans", sans-serif';
        dCtx.fillText(String(curBpm), 28, 220);

        dCtx.fillStyle = signalColor;
        dCtx.font = 'bold 20px "JetBrains Mono", monospace';
        dCtx.fillText(`BPM  •  ${curTemp.toFixed(1)}°C`, 114, 215);
      } else {
        dCtx.fillStyle = '#e2e8f0';
        dCtx.font = 'bold 22px "Plus Jakarta Sans", sans-serif';
        dCtx.fillText(
          curWorker ? 'Awaiting real band report' : 'Pair worker band to stream',
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

    // 6. Sapphire Crystal Glass Top Layer
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

    // 7. Underside Biometric Optical PPG & Skin Thermistor Array (faces inward toward wrist skin)
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

    const thermistorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.125, 0.16, 32),
      new THREE.MeshStandardMaterial({
        color: 0xe3a72f,
        roughness: 0.22,
        metalness: 0.92,
      }),
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

    // Dual flanking infrared/red LED photodiodes
    const flankMat = new THREE.MeshBasicMaterial({ color: 0xe3a72f });
    const flankL = new THREE.Mesh(new THREE.CircleGeometry(0.028, 16), flankMat);
    flankL.rotation.y = Math.PI;
    flankL.position.set(-0.092, 0, -0.026);
    sensorGroup.add(flankL);

    const flankR = flankL.clone();
    flankR.position.set(0.092, 0, -0.026);
    sensorGroup.add(flankR);

    // Initial presentation tilt showing horizontal top OLED + open wrist loop
    bandGroup.rotation.set(0.16, -0.42, 0.06);

    // Pre-warm shaders when GPU is present
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

    // Animation / Render Loop
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

      // Sync material properties smoothly
      bandMat.color.setHex(cur.finish.bandColor);
      bandMat.roughness = cur.finish.bandRoughness;
      bandMat.metalness = cur.finish.bandMetalness;

      chassisMat.color.setHex(cur.finish.chassisColor);
      chassisMat.roughness = cur.finish.chassisRoughness;
      chassisMat.metalness = cur.finish.chassisMetalness;

      claspMat.color.setHex(cur.finish.claspColor);
      claspMat.roughness = cur.finish.claspRoughness;
      claspMat.metalness = cur.finish.claspMetalness;

      // Smoothly damp exploded view separation
      const targetExplode = cur.exploded ? 1 : 0;
      explodeFactor = THREE.MathUtils.damp(explodeFactor, targetExplode, 7, delta);
      screenMesh.position.z = 0.135 + explodeFactor * 0.42;
      displayPlate.position.z = 0.118 + explodeFactor * 0.24;
      bezelMesh.position.z = 0.096 + explodeFactor * 0.12;
      sensorGroup.position.z = -0.1 - explodeFactor * 0.32;
      claspGroup.position.y = -1.12 - explodeFactor * 0.26;

      // Smoothly damp camera preset transitions
      if (cur.presetTransitionActive) {
        const targetPreset = CAMERA_PRESETS[cur.preset];
        _targetCamPos.set(...targetPreset.pos);
        _targetCtrl.set(...targetPreset.target);
        const lerpAlpha = 1 - Math.exp(-5.5 * delta);
        camera.position.lerp(_targetCamPos, lerpAlpha);
        controls.target.lerp(_targetCtrl, lerpAlpha);
        if (camera.position.distanceTo(_targetCamPos) < 0.02) {
          cur.presetTransitionActive = false;
        }
      }

      // Gentle auto-orbit & levitation when idle
      if (cur.autoOrbit && !cur.presetTransitionActive) {
        bandGroup.rotation.y += delta * 0.28;
      }
      bandGroup.position.y = Math.sin(elapsed * 1.4) * 0.045;

      // Pulse underside PPG optical sensor when real telemetry or diagnostic scan is active
      const hasReport = cur.bpm !== null && cur.bpm > 0;
      const pulseSpeed = cur.isDiagnosing
        ? 8.5
        : hasReport
          ? ((cur.bpm as number) / 60) * Math.PI * 2
          : 0;
      const pulse =
        cur.isDiagnosing || hasReport ? (Math.sin(elapsed * pulseSpeed) + 1) * 0.5 : 0.08;
      const hue = cur.isDiagnosing
        ? 0.54
        : cur.condition === 'critical'
          ? 0.05
          : cur.condition === 'caution'
            ? 0.11
            : 0.43;
      sensorGlowMat.color.setHSL(
        hue,
        hasReport || cur.isDiagnosing ? 1.0 : 0.25,
        0.22 + pulse * 0.34,
      );

      // Update OLED texture at ~15fps
      if (elapsed - lastOledUpdate > 0.066) {
        lastOledUpdate = elapsed;
        updateOled(elapsed);
      }

      controls.update();
      renderer.render(scene, camera);

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
      bandGeo.dispose();
      coreCaseGeo.dispose();
      bezelGeo.dispose();
      screenMesh.geometry.dispose();
      displayPlate.geometry.dispose();
      claspMain.geometry.dispose();
      claspTrimL.geometry.dispose();
      claspTrimR.geometry.dispose();
      sensorRing.geometry.dispose();
      thermistorRing.geometry.dispose();
      sensorLedCenter.geometry.dispose();
      flankL.geometry.dispose();
      contactShadow.geometry.dispose();

      bandMat.dispose();
      chassisMat.dispose();
      claspMat.dispose();
      claspRingMat.dispose();
      glassMat.dispose();
      (displayPlate.material as THREE.Material).dispose();
      (sensorRing.material as THREE.Material).dispose();
      (thermistorRing.material as THREE.Material).dispose();
      sensorGlowMat.dispose();
      flankMat.dispose();
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

  return (
    <div className="relative w-full h-[380px] sm:h-[420px] lg:h-[460px] bg-gradient-to-b from-obsidian-900 via-obsidian-850 to-obsidian-950 overflow-hidden select-none">
      {/* Ambient Radial Accents */}
      <div className="pointer-events-none absolute -top-14 -left-14 w-48 h-48 rounded-full bg-emeraldGlow/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-12 -right-12 w-52 h-52 rounded-full bg-titaniumGold/10 blur-3xl" />

      {/* Top Stage Indicators */}
      <div className="absolute top-3.5 left-3.5 right-3.5 z-20 flex items-center justify-between gap-2 pointer-events-none">
        <div className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-medium text-slate-200 bg-[#070b0e]/90 border border-white/10">
          <View className="w-3.5 h-3.5 text-titaniumGold" aria-hidden="true" />
          <span>360° Interactive Studio</span>
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

      {/* Isolated WebGL Canvas Mount */}
      {!webglError ? (
        <div
          ref={mountRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          aria-label="Interactive 3D JaanBand Core MK-IV model"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center px-6 text-center">
          <div className="w-24 h-24 rounded-full border-4 border-emeraldGlow/40 bg-obsidian-800 flex items-center justify-center mb-3">
            <View className="w-9 h-9 text-emeraldGlow" />
          </div>
          <p className="text-sm font-semibold text-white">JaanBand Core MK-IV</p>
          <p className="text-xs text-slate-400 mt-1 max-w-xs">
            3D hardware studio preview unavailable in this browser context.
          </p>
        </div>
      )}

      {/* Collapsible Bottom Control Dock (Zero Center Occlusion) */}
      <div className="absolute bottom-3 left-3 right-3 z-20 flex flex-col items-center pointer-events-none">
        <button
          type="button"
          onClick={() => setHudCollapsed((c) => !c)}
          className="pointer-events-auto mb-1.5 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#070b0e]/90 border border-white/10 text-[10px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
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
          <div className="pointer-events-auto w-full max-w-[410px] rounded-2xl bg-[#070b0e]/92 border border-white/10 p-1.5 flex items-center justify-between gap-1.5 shadow-xl">
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
              title="Toggle exploded hardware assembly"
            >
              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{exploded ? 'Assembled' : 'Explode'}</span>
            </button>
          </div>
        )}

        {hudCollapsed && (
          <div className="pointer-events-none mt-0.5 px-3 py-1 rounded-full bg-[#070b0e]/85 border border-white/10 flex items-center gap-1.5">
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
