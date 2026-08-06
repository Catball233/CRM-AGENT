import { ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import { asApiException } from "./errors";

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): void;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const apiException = asApiException(exception);
    response.status(apiException.status).json(apiException.body);
  }
}
