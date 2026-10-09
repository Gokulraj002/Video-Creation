import { templateCatalogSummary, type SystemConfigDTO } from '@vc/schema';
import type { AppConfig } from '../config';
import { engineAvailabilityList } from '../director/engines';
import type { DirectorFactory } from '../director/factory';

/** Public, secret-free view of the studio configuration. */
export function systemConfig(config: AppConfig, factory: DirectorFactory, queueDriver: 'bullmq' | 'inline'): SystemConfigDTO {
  return {
    aiProvider: { ...factory.providerInfo },
    queueDriver,
    limits: { ...config.limits },
    engines: engineAvailabilityList(),
    templates: templateCatalogSummary(),
    promptVersion: factory.promptVersion,
  };
}
