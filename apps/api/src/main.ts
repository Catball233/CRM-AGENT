import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./conversation/api-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ApiExceptionFilter());
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, "127.0.0.1");
}

void bootstrap();
