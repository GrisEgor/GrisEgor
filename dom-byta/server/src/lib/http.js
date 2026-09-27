"use strict";

// Ошибка с HTTP-кодом и машинным кодом для клиента: { error: "code", message }.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.statusCode = status;
    this.code = code;
  }
}

const badRequest = (code, message) => new HttpError(400, code, message);
const unauthorized = () => new HttpError(401, "unauthorized", "Нужно войти");
const forbidden = (message = "Недостаточно прав") => new HttpError(403, "forbidden", message);
const notFound = (message = "Не найдено") => new HttpError(404, "not_found", message);

function str(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, str };
