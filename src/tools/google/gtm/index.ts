/**
 * Google Tag Manager tools module
 *
 * Tools for managing GTM accounts, containers, workspaces, tags, triggers, variables, and versions.
 */

// Accounts, Containers, Workspaces
export {
  gtmListAccountsTool,
  gtmListContainersTool,
  gtmGetContainerTool,
  gtmListWorkspacesTool,
  gtmGetWorkspaceTool,
} from './accounts.js';

// Tags
export {
  gtmListTagsTool,
  gtmGetTagTool,
  gtmCreateTagTool,
  gtmUpdateTagTool,
  gtmDeleteTagTool,
} from './tags.js';

// Triggers
export {
  gtmListTriggersTool,
  gtmGetTriggerTool,
  gtmCreateTriggerTool,
  gtmUpdateTriggerTool,
  gtmDeleteTriggerTool,
} from './triggers.js';

// Variables
export {
  gtmListVariablesTool,
  gtmGetVariableTool,
  gtmCreateVariableTool,
  gtmUpdateVariableTool,
  gtmDeleteVariableTool,
} from './variables.js';

// Versions
export {
  gtmListVersionsTool,
  gtmGetVersionTool,
  gtmCreateVersionTool,
  gtmPublishVersionTool,
  gtmGetLiveVersionTool,
} from './versions.js';

import {
  gtmListAccountsTool,
  gtmListContainersTool,
  gtmGetContainerTool,
  gtmListWorkspacesTool,
  gtmGetWorkspaceTool,
} from './accounts.js';
import {
  gtmListTagsTool,
  gtmGetTagTool,
  gtmCreateTagTool,
  gtmUpdateTagTool,
  gtmDeleteTagTool,
} from './tags.js';
import {
  gtmListTriggersTool,
  gtmGetTriggerTool,
  gtmCreateTriggerTool,
  gtmUpdateTriggerTool,
  gtmDeleteTriggerTool,
} from './triggers.js';
import {
  gtmListVariablesTool,
  gtmGetVariableTool,
  gtmCreateVariableTool,
  gtmUpdateVariableTool,
  gtmDeleteVariableTool,
} from './variables.js';
import {
  gtmListVersionsTool,
  gtmGetVersionTool,
  gtmCreateVersionTool,
  gtmPublishVersionTool,
  gtmGetLiveVersionTool,
} from './versions.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All GTM tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gtmTools: ToolDefinition<any, any>[] = [
  // Accounts & Containers
  gtmListAccountsTool,
  gtmListContainersTool,
  gtmGetContainerTool,
  gtmListWorkspacesTool,
  gtmGetWorkspaceTool,
  // Tags
  gtmListTagsTool,
  gtmGetTagTool,
  gtmCreateTagTool,
  gtmUpdateTagTool,
  gtmDeleteTagTool,
  // Triggers
  gtmListTriggersTool,
  gtmGetTriggerTool,
  gtmCreateTriggerTool,
  gtmUpdateTriggerTool,
  gtmDeleteTriggerTool,
  // Variables
  gtmListVariablesTool,
  gtmGetVariableTool,
  gtmCreateVariableTool,
  gtmUpdateVariableTool,
  gtmDeleteVariableTool,
  // Versions
  gtmListVersionsTool,
  gtmGetVersionTool,
  gtmCreateVersionTool,
  gtmPublishVersionTool,
  gtmGetLiveVersionTool,
];

