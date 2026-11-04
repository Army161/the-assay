import type { Metadata } from "next";
import { RecordView } from "@/components/record-view";
export const metadata: Metadata = { title: "The record", description: "Every Assay reading, sealed in a hash chain before its outcome is known, with the live graduation rate by tier." };
export default function RecordPage() { return <RecordView />; }
