import type { Metadata } from "next";
import { CreateForm } from "@/components/create-form";
export const metadata: Metadata = { title: "Launch a coin" };
export default function CreatePage() { return <CreateForm />; }
