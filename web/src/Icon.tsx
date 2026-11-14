import type { CSSProperties } from 'react';
import {
  PanelsTopLeft,
  FolderGit2,
  ShieldCheck,
  Database,
  SlidersHorizontal,
  RefreshCw,
  LogOut,
  ArrowRight,
  ChevronDown,
  Check,
  TriangleAlert,
  Inbox,
  Info,
  Clock3,
  CirclePause,
  CircleSlash,
  CircleCheck,
  CircleAlert,
  LoaderCircle,
  Bot,
  Wrench,
  Settings,
  Search,
  Plus,
  Command,
  Sun,
  Moon,
  ChartColumn,
} from 'lucide-react';
const icons = {
  work: PanelsTopLeft,
  projects: FolderGit2,
  security: ShieldCheck,
  memory: Database,
  settings: SlidersHorizontal,
  refresh: RefreshCw,
  logout: LogOut,
  arrow: ArrowRight,
  'chevron-down': ChevronDown,
  check: Check,
  alert: TriangleAlert,
  empty: Inbox,
  info: Info,
  queued: Clock3,
  paused: CirclePause,
  cancelled: CircleSlash,
  completed: CircleCheck,
  failed: CircleAlert,
  running: LoaderCircle,
  agents: Bot,
  tools: Wrench,
  config: Settings,
  search: Search,
  plus: Plus,
  command: Command,
  sun: Sun,
  moon: Moon,
  insights: ChartColumn,
} as const;
export type IconName = keyof typeof icons;
export default function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" style={style} />;
}
