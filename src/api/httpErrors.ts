export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function unauthorized(message = "Unauthorized"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function badRequest(message = "Bad request"): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function conflict(message = "Conflict"): HttpError {
  return new HttpError(409, "conflict", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}
