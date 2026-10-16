import type { Plugin } from "../core/types";
import { translate } from "./translate";
import { materials, tools } from "./counter";
import { tasks } from "./tasks";

/**
 * Every available plugin, by name. A group turns plugins on in the "groups" table (defaults: config/defaults.ts).
 * To add one (roster, tools, logistics, shortages, …): create src/plugins/<name>/index.ts
 * exporting a Plugin, then register it here.
 */
export const plugins: Record<string, Plugin> = {
  [translate.name]: translate,
  [tasks.name]: tasks,
  [tools.name]: tools,
  [materials.name]: materials,
};
