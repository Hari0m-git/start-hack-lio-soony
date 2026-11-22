import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, MathUtils, MeshStandardMaterial, type Group, type Mesh } from "three";

/** One packing line as the scene shows it. Every value is derived from the forecast by the caller. */
export type DockLine = { id: string; stopped: boolean; speed: number; ghosts: number };

const BELT_START = -5.4;
const SPACING = 1.25;
const BOXES = 8;
const MAX_GHOSTS = 12;

type Palette = Record<"ground" | "wall" | "roof" | "belt" | "accent" | "bad" | "good" | "coral" | "peach" | "ink", string>;

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ground: v("--color-floor"), wall: v("--color-solid"), roof: v("--color-coral"), belt: v("--color-line"),
    accent: v("--color-accent"), bad: v("--color-bad"), good: v("--color-good"), coral: v("--color-coral"), peach: v("--color-peach"), ink: v("--color-ink-2"),
  };
}

/** Counts up whenever the theme changes, so a scene can read its colours again. */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const system = matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener("foredock-theme", bump);
    system.addEventListener("change", bump);
    return () => {
      window.removeEventListener("foredock-theme", bump);
      system.removeEventListener("change", bump);
    };
  }, []);
  return tick;
}

function Rig() {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    camera.zoom = Math.min(size.width / 21, size.height / 11.5);
    camera.lookAt(0.6, 0.6, 0.2);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size, invalidate]);
  return null;
}

function Ghost({ index, z, shown, material }: { index: number; z: number; shown: boolean; material: MeshStandardMaterial }) {
  const ref = useRef<Mesh>(null);
  const col = index % 3;
  const row = Math.floor(index / 3) % 2;
  const layer = Math.floor(index / 6);
  const initial = useRef(shown ? 1 : 0); // set once; afterwards only the frame loop moves it, so changes ease in
  useFrame((_, dt) => {
    if (!ref.current) return;
    const s = MathUtils.damp(ref.current.scale.x, shown ? 1 : 0, 6, Math.min(dt, 0.05));
    ref.current.scale.setScalar(s);
    ref.current.visible = s > 0.02;
  });
  return (
    <mesh ref={ref} material={material} position={[5.45 + col * 0.56, 0.78 + layer * 0.52, z - 0.28 + row * 0.56]} scale={initial.current}>
      <boxGeometry args={[0.46, 0.46, 0.46]} />
    </mesh>
  );
}

function Line({ z, line, palette, ghostMaterial }: { z: number; line: DockLine; palette: Palette; ghostMaterial: MeshStandardMaterial }) {
  const boxes = useRef<Group>(null);
  const speed = useRef(line.stopped ? 0 : line.speed);
  const glow = useRef(line.stopped ? 1 : 0);
  const offset = useRef(0);
  const station = useMemo(() => new MeshStandardMaterial({ roughness: 0.6 }), []);
  const running = useMemo(() => new Color(palette.good), [palette]); // a running line is dark, a standing one crimson
  const halted = useMemo(() => new Color(palette.bad), [palette]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    speed.current = MathUtils.damp(speed.current, line.stopped ? 0 : line.speed, 3, d);
    glow.current = MathUtils.damp(glow.current, line.stopped ? 1 : 0, 4, d);
    offset.current = (offset.current + speed.current * d) % SPACING;
    boxes.current?.children.forEach((box, i) => (box.position.x = BELT_START + i * SPACING + offset.current));
    station.color.copy(running).lerp(halted, glow.current);
    station.emissive.copy(station.color);
    station.emissiveIntensity = 0.15 + glow.current * (0.45 + 0.25 * Math.sin(state.clock.elapsedTime * 3));
  });

  return (
    <group>
      <mesh position={[-0.4, 0.15, z]}>
        <boxGeometry args={[10.6, 0.3, 1]} />
        <meshStandardMaterial color={palette.belt} roughness={0.9} />
      </mesh>
      <group ref={boxes}>
        {Array.from({ length: BOXES }, (_, i) => (
          <mesh key={i} position={[BELT_START + i * SPACING, 0.56, z]}>
            <boxGeometry args={[0.52, 0.52, 0.52]} />
            <meshStandardMaterial color={palette.wall} roughness={0.8} />
          </mesh>
        ))}
      </group>
      {[-0.66, 0.66].map((side) => (
        <mesh key={side} material={station} position={[-1, 0.9, z + side]}>
          <boxGeometry args={[0.2, 1.5, 0.2]} />
        </mesh>
      ))}
      <mesh material={station} position={[-1, 1.72, z]}>
        <boxGeometry args={[0.5, 0.24, 1.6]} />
      </mesh>
      {Array.from({ length: MAX_GHOSTS }, (_, i) => (
        <Ghost key={i} index={i} z={z} shown={i < line.ghosts} material={ghostMaterial} />
      ))}
      <group position={[8.5, 0, z]}>
        <mesh position={[0, 0.9, 0]}>
          <boxGeometry args={[2.3, 1.2, 1.15]} />
          <meshStandardMaterial color={palette.wall} roughness={0.8} />
        </mesh>
        <mesh position={[1.55, 0.72, 0]}>
          <boxGeometry args={[0.7, 0.86, 1.05]} />
          <meshStandardMaterial color={palette.coral} roughness={0.7} />
        </mesh>
        {[-0.7, 0.6, 1.55].map((x) => (
          <mesh key={x} position={[x, 0.2, 0]}>
            <boxGeometry args={[0.4, 0.4, 1.25]} />
            <meshStandardMaterial color={palette.ink} roughness={1} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The container that only arrives if someone acts: it drives in when that view is shown. */
function Container({ arriving, palette }: { arriving: boolean; palette: Palette }) {
  const ref = useRef<Group>(null);
  const initial = useRef(arriving ? 5.4 : -15);
  useFrame((_, dt) => {
    if (!ref.current) return;
    ref.current.position.x = MathUtils.damp(ref.current.position.x, arriving ? 5.4 : -15, 2.2, Math.min(dt, 0.05));
    ref.current.visible = ref.current.position.x > -11.5;
  });
  return (
    <group ref={ref} position={[initial.current, 0, 3.9]} visible={initial.current > -11.5}>
      <mesh position={[0, 0.85, 0]}>
        <boxGeometry args={[2.6, 1.1, 1.05]} />
        <meshStandardMaterial color={palette.peach} roughness={0.7} />
      </mesh>
      <mesh position={[1.7, 0.7, 0]}>
        <boxGeometry args={[0.7, 0.82, 1]} />
        <meshStandardMaterial color={palette.accent} roughness={0.7} />
      </mesh>
      {[-0.8, 0.7, 1.7].map((x) => (
        <mesh key={x} position={[x, 0.2, 0]}>
          <boxGeometry args={[0.4, 0.4, 1.2]} />
          <meshStandardMaterial color={palette.ink} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

export default function DockScene({ lines, container, active }: { lines: DockLine[]; container: boolean; active: boolean }) {
  const theme = useThemeTick();
  const [settling, setSettling] = useState(true);
  const palette = useMemo(readPalette, [theme]);
  const ghostMaterial = useMemo(
    () => new MeshStandardMaterial({ color: palette.bad, transparent: true, opacity: 0.42, roughness: 0.5, depthWrite: false }),
    [palette],
  );

  // After a change the scene needs a moment of frames to ease into its new state, even if nothing else moves.
  const signature = lines.map((l) => `${l.stopped}${l.ghosts}`).join() + container + theme;
  useEffect(() => {
    setSettling(true);
    const done = setTimeout(() => setSettling(false), 2600);
    return () => clearTimeout(done);
  }, [signature]);

  const moving = lines.some((l) => !l.stopped) || settling;
  return (
    <Canvas
      flat
      orthographic
      dpr={[1, 2]}
      frameloop={active && moving ? "always" : "demand"}
      camera={{ position: [12, 10, 12], near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      aria-hidden
    >
      <Rig />
      <ambientLight intensity={1.7} />
      <directionalLight position={[-6, 12, 4]} intensity={2.3} />
      <directionalLight position={[8, 4, -6]} intensity={0.9} color={palette.coral} />
      <mesh position={[0.4, -0.15, 0.2]}>
        <boxGeometry args={[20.4, 0.3, 8.6]} />
        <meshStandardMaterial color={palette.ground} roughness={1} />
      </mesh>
      <mesh position={[-7.5, 1.2, 0]}>
        <boxGeometry args={[3, 2.4, 6.4]} />
        <meshStandardMaterial color={palette.wall} roughness={0.9} />
      </mesh>
      <mesh position={[-7.5, 2.52, 0]}>
        <boxGeometry args={[3.3, 0.24, 6.7]} />
        <meshStandardMaterial color={palette.roof} roughness={0.8} />
      </mesh>
      <mesh position={[6, 0.25, 0]}>
        <boxGeometry args={[2.3, 0.5, 6.6]} />
        <meshStandardMaterial color={palette.wall} roughness={0.9} />
      </mesh>
      {lines.map((line, i) => (
        <Line key={line.id} z={(i - (lines.length - 1) / 2) * 2.7} line={line} palette={palette} ghostMaterial={ghostMaterial} />
      ))}
      <Container arriving={container} palette={palette} />
    </Canvas>
  );
}
