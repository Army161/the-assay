import type { Metadata } from "next";
import { CallersView } from "@/components/callers-view";
export const metadata: Metadata = { title: "Callers" };
export default function CallersPage() { return <CallersView />; }
