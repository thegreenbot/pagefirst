import { notFound } from "next/navigation";
import { spikeEnabled } from "@/lib/spike/drive-probe";
import { DriveSpike } from "./drive-spike";

export const dynamic = "force-dynamic";

export default function DriveSpikePage() {
  if (!spikeEnabled()) notFound();
  return <DriveSpike />;
}
