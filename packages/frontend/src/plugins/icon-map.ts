// Catalog entries carry a lucide icon NAME (validated in the catalog repo
// against the lucide intersection). Importing every lucide icon to resolve
// names dynamically would ship the whole set to the client for one lookup,
// so this map is curated: add an entry when a published plugin uses a new
// icon. Unknown names fall back to Puzzle.
import { Clock, FileCheck, type LucideIcon, Network, Puzzle, Receipt } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Clock,
  FileCheck,
  Network,
  Receipt,
};

export function catalogIcon(name: string): LucideIcon {
  return ICONS[name] ?? Puzzle;
}
