/**
 * Google Tag Manager - Tags tools
 */

import { z } from 'zod';
import { getGTMClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GTMTag, GTMParameter } from '../../../types/google.js';

const log = createServiceLogger('gtm-tags');

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

// ============================================
// List Tags
// ============================================

const listTagsSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListTagsInput = z.infer<typeof listTagsSchema>;

interface ListTagsOutput {
  tags: GTMTag[];
  nextPageToken?: string;
}

export const gtmListTagsTool: ToolDefinition<ListTagsInput, ListTagsOutput> = {
  name: 'gtm_list_tags',
  description: 'Lists all tags in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: listTagsSchema,

  async handler(input: ListTagsInput): Promise<ListTagsOutput> {
    log.info('Listing GTM tags', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.tags.list({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      pageToken: input.pageToken,
    });

    const tags: GTMTag[] = (response.data.tag || []).map((t) => ({
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      tagId: t.tagId || '',
      name: t.name || '',
      type: t.type || '',
      firingTriggerId: t.firingTriggerId || [],
      blockingTriggerId: t.blockingTriggerId || undefined,
      parameter: (t.parameter || []) as GTMParameter[],
      fingerprint: t.fingerprint || '',
      parentFolderId: t.parentFolderId || undefined,
      paused: t.paused || undefined,
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    }));

    log.info('Listed GTM tags', { count: tags.length });

    return {
      tags,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Tag
// ============================================

const getTagSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  tagId: z.string().describe('GTM Tag ID'),
});

type GetTagInput = z.infer<typeof getTagSchema>;

export const gtmGetTagTool: ToolDefinition<GetTagInput, GTMTag> = {
  name: 'gtm_get_tag',
  description: 'Gets a specific tag configuration from GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: getTagSchema,

  async handler(input: GetTagInput): Promise<GTMTag> {
    log.info('Getting GTM tag', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.tags.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/tags/${input.tagId}`,
    });

    const t = response.data;

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      tagId: t.tagId || '',
      name: t.name || '',
      type: t.type || '',
      firingTriggerId: t.firingTriggerId || [],
      blockingTriggerId: t.blockingTriggerId || undefined,
      parameter: (t.parameter || []) as GTMParameter[],
      fingerprint: t.fingerprint || '',
      parentFolderId: t.parentFolderId || undefined,
      paused: t.paused || undefined,
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Create Tag
// ============================================

const createTagSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  tag: z.object({
    name: z.string().describe('Tag name'),
    type: z.string().describe('Tag type (e.g., gaawe for GA4, html for Custom HTML)'),
    parameter: z.array(gtmParameterSchema).optional().describe('Tag parameters'),
    firingTriggerId: z.array(z.string()).describe('Trigger IDs that fire this tag'),
    blockingTriggerId: z.array(z.string()).optional().describe('Trigger IDs that block this tag'),
    paused: z.boolean().optional().describe('Whether the tag is paused'),
  }),
});

type CreateTagInput = z.infer<typeof createTagSchema>;

export const gtmCreateTagTool: ToolDefinition<CreateTagInput, GTMTag> = {
  name: 'gtm_create_tag',
  description: 'Creates a new tag in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: createTagSchema,

  async handler(input: CreateTagInput): Promise<GTMTag> {
    log.info('Creating GTM tag', { name: input.tag.name, type: input.tag.type });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.tags.create({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      requestBody: {
        name: input.tag.name,
        type: input.tag.type,
        parameter: input.tag.parameter,
        firingTriggerId: input.tag.firingTriggerId,
        blockingTriggerId: input.tag.blockingTriggerId,
        paused: input.tag.paused,
      },
    });

    const t = response.data;

    log.info('Created GTM tag', { tagId: t.tagId, name: t.name });

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      tagId: t.tagId || '',
      name: t.name || '',
      type: t.type || '',
      firingTriggerId: t.firingTriggerId || [],
      blockingTriggerId: t.blockingTriggerId || undefined,
      parameter: (t.parameter || []) as GTMParameter[],
      fingerprint: t.fingerprint || '',
      parentFolderId: t.parentFolderId || undefined,
      paused: t.paused || undefined,
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Update Tag
// ============================================

const updateTagSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  tagId: z.string().describe('GTM Tag ID'),
  fingerprint: z.string().describe('Tag fingerprint for optimistic locking'),
  tag: z.object({
    name: z.string().optional().describe('New tag name'),
    type: z.string().optional().describe('New tag type'),
    parameter: z.array(gtmParameterSchema).optional().describe('New tag parameters'),
    firingTriggerId: z.array(z.string()).optional().describe('New firing trigger IDs'),
    blockingTriggerId: z.array(z.string()).optional().describe('New blocking trigger IDs'),
    paused: z.boolean().optional().describe('Whether the tag is paused'),
  }),
});

type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const gtmUpdateTagTool: ToolDefinition<UpdateTagInput, GTMTag> = {
  name: 'gtm_update_tag',
  description: 'Updates an existing tag in GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: updateTagSchema,

  async handler(input: UpdateTagInput): Promise<GTMTag> {
    log.info('Updating GTM tag', { tagId: input.tagId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.tags.update({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/tags/${input.tagId}`,
      fingerprint: input.fingerprint,
      requestBody: {
        name: input.tag.name,
        type: input.tag.type,
        parameter: input.tag.parameter,
        firingTriggerId: input.tag.firingTriggerId,
        blockingTriggerId: input.tag.blockingTriggerId,
        paused: input.tag.paused,
      },
    });

    const t = response.data;

    log.info('Updated GTM tag', { tagId: t.tagId });

    return {
      accountId: t.accountId || '',
      containerId: t.containerId || '',
      workspaceId: t.workspaceId || '',
      tagId: t.tagId || '',
      name: t.name || '',
      type: t.type || '',
      firingTriggerId: t.firingTriggerId || [],
      blockingTriggerId: t.blockingTriggerId || undefined,
      parameter: (t.parameter || []) as GTMParameter[],
      fingerprint: t.fingerprint || '',
      parentFolderId: t.parentFolderId || undefined,
      paused: t.paused || undefined,
      path: t.path || '',
      tagManagerUrl: t.tagManagerUrl || '',
    };
  },
};

// ============================================
// Delete Tag
// ============================================

const deleteTagSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  tagId: z.string().describe('GTM Tag ID to delete'),
});

type DeleteTagInput = z.infer<typeof deleteTagSchema>;

interface DeleteTagOutput {
  success: boolean;
  tagId: string;
}

export const gtmDeleteTagTool: ToolDefinition<DeleteTagInput, DeleteTagOutput> = {
  name: 'gtm_delete_tag',
  description: 'Deletes a tag from a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: deleteTagSchema,

  async handler(input: DeleteTagInput): Promise<DeleteTagOutput> {
    log.info('Deleting GTM tag', input);

    const gtm = await getGTMClient();

    await gtm.accounts.containers.workspaces.tags.delete({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/tags/${input.tagId}`,
    });

    log.info('Deleted GTM tag', { tagId: input.tagId });

    return {
      success: true,
      tagId: input.tagId,
    };
  },
};
