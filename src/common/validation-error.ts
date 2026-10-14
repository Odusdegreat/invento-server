import type { ValidationError } from 'class-validator';
import { ApiError, type FieldError } from './api-error.js';

const amountProperties = new Set(['amount', 'units']);

// The global pipe runs with forbidNonWhitelisted, so an unknown key arrives
// without constraints. Dotted paths let a client attach the message to a
// nested form input.
function flatten(errors: ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((error) => {
    const key = prefix ? `${prefix}.${error.property}` : error.property;
    const message =
      Object.values(error.constraints ?? {})[0] ?? 'Field is not allowed';
    const own = error.constraints ? [{ key, message }] : [];
    return [...own, ...flatten(error.children ?? [], key)];
  });
}

export function validationError(errors: ValidationError[]): ApiError {
  const fields = flatten(errors);
  const amount = fields.find((field) =>
    amountProperties.has(field.key.split('.').pop() ?? ''),
  );
  if (amount)
    return new ApiError(
      400,
      'invalid_amount',
      'Amount or units are outside supported limits',
      amount.key,
      fields,
    );
  return new ApiError(
    400,
    'validation_error',
    'Request fields failed validation',
    fields[0]?.key,
    fields,
  );
}
