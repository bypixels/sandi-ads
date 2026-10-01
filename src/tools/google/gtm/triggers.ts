/**
 * Google Tag Manager - Triggers tools
 */

import { z } from 'zod';
import { getGTMClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GTMTrigger, GTMCondition, GTMParameter } from '../../../types/google.js';

const log = createServiceLogger('gtm-triggers');

// Parameter schema for GTM
const gtmParameterSchema: z.ZodType<GTMParameter> = z.lazy(() =>
  z.object({
    type: z.string(),
    key: z.string(),
    value: z.string().optional(),
    list: z.array(gtmParameterSchema).optional(),
    map: z.array(gtmParameterSchema).optional(),
  })
);

// Condition schema for triggers
const gtmConditionSchema: z.ZodType<GTMCondition> = z.object({
  type: z.string(),
  parameter: z.array(gtmParameterSchema),
});

// ============================================
// List Triggers
// ============================================

const listTriggersSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListTriggersInput = z.infer<typeof listTriggersSchema>;

interface ListTriggersOutput {
  triggers: GTMTrigger[];
  nextPageToken?: string;
}

export const gtmListTriggersTool: ToolDefinition<ListTriggersInput, ListTriggersOutput> = {
  name: 'gtm_list_triggers',
  description: 'Lists all triggers in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: listTriggersSchema,

  async handler(input: ListTriggersInput): Promise<ListTriggersOutput> {
    log.info('Listing GTM triggers', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.triggers.list({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      pageToken: input.pageToken,
    });

    const triggers: GTMTrigger[] = (response.data.trigger || []).map((t) => ({
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      triggerId: t.triggerId || '',
      name: t.name || '',
      type: t.type || '',
      filter: (t.filter || undefined) as GTMCondition[] | undefined,
      autoEventFilter: (t.autoEventFilter || undefined) as GTMCondition[] | undefined,
      customEventFilter: (t.customEventFilter || undefined) as GTMCondition[] | undefined,
      fingerprint: t.fingerprint || '',
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    }));

    log.info('Listed GTM triggers', { count: triggers.length });

    return {
      triggers,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Trigger
// ============================================

const getTriggerSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  triggerId: z.string().describe('GTM Trigger ID'),
});

type GetTriggerInput = z.infer<typeof getTriggerSchema>;

export const gtmGetTriggerTool: ToolDefinition<GetTriggerInput, GTMTrigger> = {
  name: 'gtm_get_trigger',
  description: 'Gets a specific trigger configuration from GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: getTriggerSchema,

  async handler(input: GetTriggerInput): Promise<GTMTrigger> {
    log.info('Getting GTM trigger', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.triggers.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/triggers/${input.triggerId}`,
    });

    const t = response.data;

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      triggerId: t.triggerId || '',
      name: t.name || '',
      type: t.type || '',
      filter: (t.filter || undefined) as GTMCondition[] | undefined,
      autoEventFilter: (t.autoEventFilter || undefined) as GTMCondition[] | undefined,
      customEventFilter: (t.customEventFilter || undefined) as GTMCondition[] | undefined,
      fingerprint: t.fingerprint || '',
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Create Trigger
// ============================================

const createTriggerSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  trigger: z.object({
    name: z.string().describe('Trigger name'),
    type: z.string().describe('Trigger type (e.g., pageview, click, customEvent, formSubmission, etc.)'),
    filter: z.array(gtmConditionSchema).optional().describe('Trigger filters'),
    autoEventFilter: z.array(gtmConditionSchema).optional().describe('Auto event filters'),
    customEventFilter: z.array(gtmConditionSchema).optional().describe('Custom event filters'),
  }),
});

type CreateTriggerInput = z.infer<typeof createTriggerSchema>;

export const gtmCreateTriggerTool: ToolDefinition<CreateTriggerInput, GTMTrigger> = {
  name: 'gtm_create_trigger',
  description: 'Creates a new trigger in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: createTriggerSchema,

  async handler(input: CreateTriggerInput): Promise<GTMTrigger> {
    log.info('Creating GTM trigger', { name: input.trigger.name, type: input.trigger.type });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.triggers.create({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      requestBody: {
        name: input.trigger.name,
        type: input.trigger.type,
        filter: input.trigger.filter,
        autoEventFilter: input.trigger.autoEventFilter,
        customEventFilter: input.trigger.customEventFilter,
      },
    });

    const t = response.data;

    log.info('Created GTM trigger', { triggerId: t.triggerId, name: t.name });

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      triggerId: t.triggerId || '',
      name: t.name || '',
      type: t.type || '',
      filter: (t.filter || undefined) as GTMCondition[] | undefined,
      autoEventFilter: (t.autoEventFilter || undefined) as GTMCondition[] | undefined,
      customEventFilter: (t.customEventFilter || undefined) as GTMCondition[] | undefined,
      fingerprint: t.fingerprint || '',
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Update Trigger
// ============================================

const updateTriggerSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  triggerId: z.string().describe('GTM Trigger ID'),
  fingerprint: z.string().describe('Trigger fingerprint for optimistic locking'),
  trigger: z.object({
    name: z.string().optional().describe('New trigger name'),
    type: z.string().optional().describe('New trigger type'),
    filter: z.array(gtmConditionSchema).optional().describe('New trigger filters'),
    autoEventFilter: z.array(gtmConditionSchema).optional().describe('New auto event filters'),
    customEventFilter: z.array(gtmConditionSchema).optional().describe('New custom event filters'),
  }),
});

type UpdateTriggerInput = z.infer<typeof updateTriggerSchema>;

export const gtmUpdateTriggerTool: ToolDefinition<UpdateTriggerInput, GTMTrigger> = {
  name: 'gtm_update_trigger',
  description: 'Updates an existing trigger in GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: updateTriggerSchema,

  async handler(input: UpdateTriggerInput): Promise<GTMTrigger> {
    log.info('Updating GTM trigger', { triggerId: input.triggerId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.triggers.update({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/triggers/${input.triggerId}`,
      fingerprint: input.fingerprint,
      requestBody: {
        name: input.trigger.name,
        type: input.trigger.type,
        filter: input.trigger.filter,
        autoEventFilter: input.trigger.autoEventFilter,
        customEventFilter: input.trigger.customEventFilter,
      },
    });

    const t = response.data;

    log.info('Updated GTM trigger', { triggerId: t.triggerId });

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      triggerId: t.triggerId || '',
      name: t.name || '',
      type: t.type || '',
      filter: (t.filter || undefined) as GTMCondition[] | undefined,
      autoEventFilter: (t.autoEventFilter || undefined) as GTMCondition[] | undefined,
      customEventFilter: (t.customEventFilter || undefined) as GTMCondition[] | undefined,
      fingerprint: t.fingerprint || '',
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Delete Trigger
// ============================================

const deleteTriggerSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  triggerId: z.string().describe('GTM Trigger ID to delete'),
});

type DeleteTriggerInput = z.infer<typeof deleteTriggerSchema>;

interface DeleteTriggerOutput {
  success: boolean;
  triggerId: string;
}

export const gtmDeleteTriggerTool: ToolDefinition<DeleteTriggerInput, DeleteTriggerOutput> = {
  name: 'gtm_delete_trigger',
  description: 'Deletes a trigger from a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: deleteTriggerSchema,

  async handler(input: DeleteTriggerInput): Promise<DeleteTriggerOutput> {
    log.info('Deleting GTM trigger', input);

    const gtm = await getGTMClient();

    await gtm.accounts.containers.workspaces.triggers.delete({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/triggers/${input.triggerId}`,
    });

    log.info('Deleted GTM trigger', { triggerId: input.triggerId });

    return {
      success: true,
      triggerId: input.triggerId,
    };
  },
};
