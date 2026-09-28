import { HttpException } from '@nestjs/common';
export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ code, message }, status);
  }
}
export function fail(code: string, message: string, status = 400): never {
  throw new ApiError(status, code, message);
}
