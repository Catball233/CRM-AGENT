import { Controller, Get } from "@nestjs/common";

@Controller("api/v1")
export class AppController {
  @Get("health")
  getHealth() {
    return {
      status: "ok",
      database: "not_initialized",
      contract_version: "1.0.0",
    };
  }
}
