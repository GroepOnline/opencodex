import { ProgressTrack } from "../../../components/primitives/progress-track";
export default function ShareMeter({ ratio }: { ratio: number }) {
  return (
    <ProgressTrack
      value={Math.round(ratio * 100)}
      className="usage-bar"
      fillClassName="usage-bar-fill"
    />
  );
}
