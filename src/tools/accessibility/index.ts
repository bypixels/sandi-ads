/**
 * Accessibility tools module
 *
 * Tools for WCAG compliance auditing, contrast checking, and image accessibility.
 */

export { a11yAuditTool } from './audit.js';
export { a11yCheckContrastTool } from './contrast.js';
export { a11yCheckImagesTool } from './images.js';

import { a11yAuditTool } from './audit.js';
import { a11yCheckContrastTool } from './contrast.js';
import { a11yCheckImagesTool } from './images.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All Accessibility tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accessibilityTools: ToolDefinition<any, any>[] = [
  a11yAuditTool,
  a11yCheckContrastTool,
  a11yCheckImagesTool,
];
