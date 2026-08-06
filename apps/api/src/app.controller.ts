import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { ConversationService } from "./conversation/conversation.service";

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
}

@Controller("api/v1")
export class AppController {
  constructor(private readonly conversations: ConversationService) {}

  @Get("health")
  getHealth() {
    return {
      status: "ok",
      database: "not_initialized",
      contract_version: "1.0.0",
    };
  }

  @Post("conversations")
  async createConversation(@Body() body: unknown) {
    return this.conversations.create(body);
  }

  @Get("conversations/:conversationId")
  async getConversation(@Param("conversationId") conversationId: string) {
    return this.conversations.getSnapshot(conversationId);
  }

  @Delete("conversations/:conversationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConversation(@Param("conversationId") conversationId: string) {
    await this.conversations.deleteLocalTestConversation(conversationId);
  }

  @Post("conversations/:conversationId/messages")
  async sendMessage(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const result = await this.conversations.submit(conversationId, body);
    const responseMode =
      typeof body === "object" && body !== null && "response_mode" in body
        ? (body as { response_mode?: unknown }).response_mode
        : undefined;
    if (responseMode === "stream") {
      response.status(HttpStatus.OK);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      for (const event of result.events) {
        response.write(`id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
      return;
    }
    if (result.kind === "failed") {
      throw result.error;
    }
    response.status(HttpStatus.OK);
    return result.result;
  }
}
