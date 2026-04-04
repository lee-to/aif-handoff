export class RuntimeError extends Error {
  public readonly code: string;

  constructor(message: string, code = "RUNTIME_ERROR", cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class RuntimeRegistrationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_REGISTRATION_ERROR", cause);
    this.name = "RuntimeRegistrationError";
  }
}

export class RuntimeResolutionError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_RESOLUTION_ERROR", cause);
    this.name = "RuntimeResolutionError";
  }
}

export class RuntimeModuleValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_VALIDATION_ERROR", cause);
    this.name = "RuntimeModuleValidationError";
  }
}

export class RuntimeModuleLoadError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_LOAD_ERROR", cause);
    this.name = "RuntimeModuleLoadError";
  }
}

export class RuntimeValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_VALIDATION_ERROR", cause);
    this.name = "RuntimeValidationError";
  }
}

export class RuntimeCapabilityError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_CAPABILITY_ERROR", cause);
    this.name = "RuntimeCapabilityError";
  }
}

export class RuntimeExecutionError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_EXECUTION_ERROR", cause);
    this.name = "RuntimeExecutionError";
  }
}
