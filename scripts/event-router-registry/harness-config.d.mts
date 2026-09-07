export type RegistryLookupBinding = {
  binding: 'REGISTRY';
  service: 'five-across-event-registry';
  entrypoint: 'RegistryLookupEntrypoint';
};

/** Retained name for the harness's own binding, which is one of two consumers. */
export type HarnessServiceBinding = RegistryLookupBinding;

export function validateRegistryLookupBinding(config: string, subject: string): RegistryLookupBinding;
/** Whether the configuration attaches routes. Throws when it cannot be read. */
export function declaresRoutes(config: string): boolean;
export function validateHarnessServiceBinding(config: string): RegistryLookupBinding;
export function validateRouterServiceBinding(config: string): RegistryLookupBinding;
