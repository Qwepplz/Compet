export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function unauthorized(code: string, message = "Unauthorized"): HttpError {
  return new HttpError(401, code, message);
}

export function forbidden(code: string, message = "Forbidden"): HttpError {
  return new HttpError(403, code, message);
}

export function badRequest(code: string, message = "Bad request"): HttpError {
  return new HttpError(400, code, message);
}

export function conflict(code: string, message = "Conflict"): HttpError {
  return new HttpError(409, code, message);
}

export function notFound(code: string, message = "Not found"): HttpError {
  return new HttpError(404, code, message);
}

export function tooManyRequests(code: string, message = "Too many requests"): HttpError {
  return new HttpError(429, code, message);
}
