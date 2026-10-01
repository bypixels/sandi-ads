/**
 * Google Analytics 4 - Metadata, Audiences, Conversions tools
 */

import { z } from 'zod';
import { getAnalyticsAdminClient, getAnalyticsDataClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('ga4-metadata');

// ============================================
// Get Metadata
// ============================================

const getMetadataSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
});

type GetMetadataInput = z.infer<typeof getMetadataSchema>;

interface DimensionMetadata {
  apiName: string;
  uiName: string;
  description: string;
  category: string;
}

interface MetricMetadata {
  apiName: string;
  uiName: string;
  description: string;
  type: string;
  category: string;
}

interface GetMetadataOutput {
  dimensions: DimensionMetadata[];
  metrics: MetricMetadata[];
}

export const ga4GetMetadataTool: ToolDefinition<GetMetadataInput, GetMetadataOutput> = {
  name: 'ga4_get_metadata',
  description: 'Gets available dimensions and metrics for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: getMetadataSchema,

  async handler(input: GetMetadataInput): Promise<GetMetadataOutput> {
    log.info('Getting GA4 metadata', { propertyId: input.propertyId });

    const analyticsData = await getAnalyticsDataClient();
    const property = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsData.properties.getMetadata({
      name: `${property}/metadata`,
    });

    const data = response.data;

    const dimensions: DimensionMetadata[] = (data.dimensions || []).map((d) => ({
      apiName: d.apiName || '',
      uiName: d.uiName || '',
      description: d.description || '',
      category: d.category || '',
    }));

    const metrics: MetricMetadata[] = (data.metrics || []).map((m) => ({
      apiName: m.apiName || '',
      uiName: m.uiName || '',
      description: m.description || '',
      type: m.type || '',
      category: m.category || '',
    }));

    log.info('GA4 metadata retrieved', {
      dimensionCount: dimensions.length,
      metricCount: metrics.length,
    });

    return { dimensions, metrics };
  },
};

// ============================================
// List Custom Dimensions
// ============================================

const listCustomDimensionsSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListCustomDimensionsInput = z.infer<typeof listCustomDimensionsSchema>;

interface CustomDimension {
  name: string;
  parameterName: string;
  displayName: string;
  description?: string;
  scope: string;
}

interface ListCustomDimensionsOutput {
  customDimensions: CustomDimension[];
  nextPageToken?: string;
}

export const ga4ListCustomDimensionsTool: ToolDefinition<ListCustomDimensionsInput, ListCustomDimensionsOutput> = {
  name: 'ga4_list_custom_dimensions',
  description: 'Lists custom dimensions defined for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: listCustomDimensionsSchema,

  async handler(input: ListCustomDimensionsInput): Promise<ListCustomDimensionsOutput> {
    log.info('Listing GA4 custom dimensions', { propertyId: input.propertyId });

    const analyticsAdmin = await getAnalyticsAdminClient();
    const parent = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsAdmin.properties.customDimensions.list({
      parent,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const customDimensions: CustomDimension[] = (response.data.customDimensions || []).map((d) => ({
      name: d.name || '',
      parameterName: d.parameterName || '',
      displayName: d.displayName || '',
      description: d.description || undefined,
      scope: d.scope || '',
    }));

    log.info('Listed GA4 custom dimensions', { count: customDimensions.length });

    return {
      customDimensions,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// List Custom Metrics
// ============================================

const listCustomMetricsSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListCustomMetricsInput = z.infer<typeof listCustomMetricsSchema>;

interface CustomMetric {
  name: string;
  parameterName: string;
  displayName: string;
  description?: string;
  measurementUnit: string;
  scope: string;
}

interface ListCustomMetricsOutput {
  customMetrics: CustomMetric[];
  nextPageToken?: string;
}

export const ga4ListCustomMetricsTool: ToolDefinition<ListCustomMetricsInput, ListCustomMetricsOutput> = {
  name: 'ga4_list_custom_metrics',
  description: 'Lists custom metrics defined for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: listCustomMetricsSchema,

  async handler(input: ListCustomMetricsInput): Promise<ListCustomMetricsOutput> {
    log.info('Listing GA4 custom metrics', { propertyId: input.propertyId });

    const analyticsAdmin = await getAnalyticsAdminClient();
    const parent = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsAdmin.properties.customMetrics.list({
      parent,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const customMetrics: CustomMetric[] = (response.data.customMetrics || []).map((m) => ({
      name: m.name || '',
      parameterName: m.parameterName || '',
      displayName: m.displayName || '',
      description: m.description || undefined,
      measurementUnit: m.measurementUnit || '',
      scope: m.scope || '',
    }));

    log.info('Listed GA4 custom metrics', { count: customMetrics.length });

    return {
      customMetrics,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// List Conversion Events
// ============================================

const listConversionEventsSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListConversionEventsInput = z.infer<typeof listConversionEventsSchema>;

interface ConversionEvent {
  name: string;
  eventName: string;
  createTime?: string;
  deletable: boolean;
  custom: boolean;
}

interface ListConversionEventsOutput {
  conversionEvents: ConversionEvent[];
  nextPageToken?: string;
}

export const ga4ListConversionEventsTool: ToolDefinition<ListConversionEventsInput, ListConversionEventsOutput> = {
  name: 'ga4_list_conversion_events',
  description: 'Lists conversion events for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: listConversionEventsSchema,

  async handler(input: ListConversionEventsInput): Promise<ListConversionEventsOutput> {
    log.info('Listing GA4 conversion events', { propertyId: input.propertyId });

    const analyticsAdmin = await getAnalyticsAdminClient();
    const parent = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsAdmin.properties.conversionEvents.list({
      parent,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const conversionEvents: ConversionEvent[] = (response.data.conversionEvents || []).map((e) => ({
      name: e.name || '',
      eventName: e.eventName || '',
      createTime: e.createTime || undefined,
      deletable: e.deletable || false,
      custom: e.custom || false,
    }));

    log.info('Listed GA4 conversion events', { count: conversionEvents.length });

    return {
      conversionEvents,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// List Data Streams
// ============================================

const listDataStreamsSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListDataStreamsInput = z.infer<typeof listDataStreamsSchema>;

interface DataStream {
  name: string;
  type: string;
  displayName: string;
  createTime: string;
  updateTime: string;
  webStreamData?: {
    measurementId: string;
    firebaseAppId?: string;
    defaultUri: string;
  };
  androidAppStreamData?: {
    firebaseAppId: string;
    packageName: string;
  };
  iosAppStreamData?: {
    firebaseAppId: string;
    bundleId: string;
  };
}

interface ListDataStreamsOutput {
  dataStreams: DataStream[];
  nextPageToken?: string;
}

export const ga4ListDataStreamsTool: ToolDefinition<ListDataStreamsInput, ListDataStreamsOutput> = {
  name: 'ga4_list_data_streams',
  description: 'Lists data streams for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: listDataStreamsSchema,

  async handler(input: ListDataStreamsInput): Promise<ListDataStreamsOutput> {
    log.info('Listing GA4 data streams', { propertyId: input.propertyId });

    const analyticsAdmin = await getAnalyticsAdminClient();
    const parent = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsAdmin.properties.dataStreams.list({
      parent,
      pageSize: input.pageSize,
      pageToken: input.pageToken,
    });

    const dataStreams: DataStream[] = (response.data.dataStreams || []).map((ds) => ({
      name: ds.name || '',
      type: ds.type || '',
      displayName: ds.displayName || '',
      createTime: ds.createTime || '',
      updateTime: ds.updateTime || '',
      webStreamData: ds.webStreamData ? {
        measurementId: ds.webStreamData.measurementId || '',
        firebaseAppId: ds.webStreamData.firebaseAppId || undefined,
        defaultUri: ds.webStreamData.defaultUri || '',
      } : undefined,
      androidAppStreamData: ds.androidAppStreamData ? {
        firebaseAppId: ds.androidAppStreamData.firebaseAppId || '',
        packageName: ds.androidAppStreamData.packageName || '',
      } : undefined,
      iosAppStreamData: ds.iosAppStreamData ? {
        firebaseAppId: ds.iosAppStreamData.firebaseAppId || '',
        bundleId: ds.iosAppStreamData.bundleId || '',
      } : undefined,
    }));

    log.info('Listed GA4 data streams', { count: dataStreams.length });

    return {
      dataStreams,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};
