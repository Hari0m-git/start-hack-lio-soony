import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, MathUtils, type Group } from "three";
import { readPalette, useThemeTick } from "./DockScene";

/** One part on the shelf. Heights are shares of what is needed, so parts of very different volume compare. */
export type ShelfPart = { id: string; onSite: number; onItsWay: number; system: number; short: boolean };

export const SHELF_SPACING = 1.6;
const NEED = 2.2; // the height that stands for "exactly what is needed"
const CAP = 1.5; // taller columns are cut off here; the figures beside the shelf give the real amount
const TURN = 0.35; // how far the camera stands to the right, in radians

function Rig({ count }: { count: number }) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    // Seen slightly from the right, so the columns have depth yet still line up with the numbers below them.
    camera.zoom = Math.min(size.width / (count * SHELF_SPACING * Math.cos(TURN)), size.height / 5.8);
    camera.lookAt(0, 1.45, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size, count, invalidate]);
  return null;
}

function Column({ x, part, chosen, onChoose, palette }: {
  x: number; part: ShelfPart; chosen: boolean; onChoose: () => void; palette: ReturnType<typeof readPalette>;
}) {
  const grow = useRef<Group>(null);
  const whole = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  const site = Math.min(part.onSite, CAP) * NEED;
  const way = Math.min(part.onItsWay, Math.max(0, CAP - part.onSite)) * NEED;
  const missing = Math.max(0, 1 - part.onSite - part.onItsWay) * NEED;
  const believed = Math.min(part.system, CAP) * NEED;
  const outline = useMemo(() => new BoxGeometry(1.04, Math.max(0.02, believed), 1.04), [believed]);

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    if (grow.current) grow.current.scale.y = MathUtils.damp(grow.current.scale.y, 1, 3.5, d); // columns rise once
    if (whole.current) whole.current.scale.setScalar(MathUtils.damp(whole.current.scale.x, hover || chosen ? 1.07 : 1, 10, d));
  });

  return (
    <group
      ref={whole}
      position={[x, 0, 0]}
      onClick={(e) => (e.stopPropagation(), onChoose())}
      onPointerOver={(e) => (e.stopPropagation(), setHover(true), (document.body.style.cursor = "pointer"))}
      onPointerOut={() => (setHover(false), (document.body.style.cursor = ""))}
    >
      <mesh position={[0, 0.04, 0]}>
        <boxGeometry args={[1.3, 0.08, 1.3]} />
        <meshStandardMaterial color={chosen ? palette.accent : palette.belt} roughness={0.9} />
      </mesh>
      <group ref={grow} scale={[1, 0.02, 1]}>
        {site > 0 && (
          <mesh position={[0, 0.08 + site / 2, 0]}>
            <boxGeometry args={[0.9, site, 0.9]} />
            <meshStandardMaterial color={palette.good} roughness={0.7} />
          </mesh>
        )}
        {way > 0 && (
          <mesh position={[0, 0.08 + site + way / 2, 0]}>
            <boxGeometry args={[0.9, way, 0.9]} />
            <meshStandardMaterial color={palette.coral} roughness={0.7} />
          </mesh>
        )}
        {missing > 0 && (
          <mesh position={[0, 0.08 + site + way + missing / 2, 0]}>
            <boxGeometry args={[0.9, missing, 0.9]} />
            <meshStandardMaterial color={palette.bad} transparent opacity={0.42} depthWrite={false} roughness={0.5} />
          </mesh>
        )}
        {Math.abs(part.system - part.onSite) > 0.01 && (
          <lineSegments position={[0, 0.08 + believed / 2, 0]}>
            <edgesGeometry args={[outline]} />
            <lineBasicMaterial color={palette.ink} />
          </lineSegments>
        )}
      </group>
      <mesh position={[0, 0.08 + NEED, 0]}>
        <boxGeometry args={[1.24, 0.06, 1.24]} />
        <meshStandardMaterial color={palette.accent} roughness={0.8} />
      </mesh>
      {/* An unseen box around the whole column, so it is easy to hit with the pointer. */}
      <mesh position={[0, (CAP * NEED) / 2, 0]}>
        <boxGeometry args={[1.4, CAP * NEED + 0.2, 1.4]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

export default function PartsScene({ parts, chosen, onChoose, active }: {
  parts: ShelfPart[]; chosen: string | null; onChoose: (id: string) => void; active: boolean;
}) {
  const theme = useThemeTick();
  const palette = useMemo(readPalette, [theme]);
  // The scene only needs frames for a moment after something changed: columns rising, a column being picked.
  const [settling, setSettling] = useState(true);
  const [stir, setStir] = useState(0);
  useEffect(() => {
    setSettling(true);
    const done = setTimeout(() => setSettling(false), 2200);
    return () => clearTimeout(done);
  }, [chosen, theme, stir, parts.length]);

  return (
    <Canvas
      flat
      orthographic
      dpr={[1, 2]}
      frameloop={active && settling ? "always" : "demand"}
      camera={{ position: [13 * Math.sin(TURN), 6, 13 * Math.cos(TURN)], near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onPointerMove={() => !settling && setStir((s) => s + 1)}
    >
      <Rig count={parts.length} />
      <ambientLight intensity={1.7} />
      <directionalLight position={[-6, 12, 6]} intensity={2.3} />
      <directionalLight position={[8, 4, -6]} intensity={0.9} color={palette.coral} />
      <mesh position={[0, -0.1, 0]}>
        <boxGeometry args={[parts.length * SHELF_SPACING + 0.6, 0.2, 2.4]} />
        <meshStandardMaterial color={palette.ground} roughness={1} />
      </mesh>
      {parts.map((part, i) => (
        <Column
          key={part.id}
          x={(i - (parts.length - 1) / 2) * SHELF_SPACING}
          part={part}
          chosen={chosen === part.id}
          onChoose={() => onChoose(part.id)}
          palette={palette}
        />
      ))}
    </Canvas>
  );
}
