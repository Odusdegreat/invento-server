import { HttpException } from '@nestjs/common';

export interface FieldError {
  key: string;
  message: string;
}

export class ApiError extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    key?: string,
    fields?: FieldError[],
  ) {
    super(
      {
        code,
        message,
        ...(key ? { key } : {}),
        ...(fields?.length ? { fields } : {}),
      },
      status,
    );
  }
}

export function fail(code: string, message: string, status = 400): never {
  throw new ApiError(status, code, message);
}

export function failField(key: string, message: string, status = 400): never {
  throw new ApiError(status, 'validation_error', message, key, [
    { key, message },
  ]);
}

export function failFields(
  code: string,
  message: string,
  fields: FieldError[],
  status = 400,
): never {
  throw new ApiError(status, code, message, fields[0]?.key, fields);
}
