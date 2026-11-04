import type { Metadata } from "next";
import { RewardsView } from "@/components/rewards-view";
export const metadata: Metadata = { title: "Holder rewards", description: "Every holder-reward payout on The Assay, with the transactions to check." };
export default function RewardsPage() { return <RewardsView />; }
