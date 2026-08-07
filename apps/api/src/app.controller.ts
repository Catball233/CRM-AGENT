import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { ConversationService } from "./conversation/conversation.service";

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  flushHeaders?(): void;
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
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    if (this.conversations.responseModeFor(body) === "stream") {
      await this.conversations.validateSubmission(conversationId, body, idempotencyKey);
      if (!this.conversations.usesDurableTurnLifecycle()) {
        response.status(HttpStatus.OK);
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders?.();
        await this.conversations.submit(conversationId, body, (event) => {
          response.write(`id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
        }, idempotencyKey);
        response.end();
        return;
      }
      const prepared = await this.conversations.prepareDurableStreamSubmission(conversationId, body, idempotencyKey);
      if (prepared.kind === "processing") {
        response.status(HttpStatus.ACCEPTED);
        return this.processingAccepted(conversationId, prepared.turn_id, prepared.client_message_id);
      }
      response.status(HttpStatus.OK);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      await this.conversations.submit(conversationId, body, (event) => {
        response.write(`id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
      }, idempotencyKey, prepared.kind === "started" ? {
        turn_id: prepared.turn_id,
        user_message: prepared.user_message,
      } : undefined);
      response.end();
      return;
    }
    const result = await this.conversations.submit(conversationId, body, undefined, idempotencyKey);
    if (result.kind === "failed") {
      throw result.error;
    }
    if (result.kind === "processing") {
      response.status(HttpStatus.ACCEPTED);
      return this.processingAccepted(conversationId, result.turn_id, result.client_message_id);
    }
    response.status(HttpStatus.OK);
    return result.result;
  }

  @Post("conversations/:conversationId/turns/:turnId/retry")
  async retryTurn(
    @Param("conversationId") conversationId: string,
    @Param("turnId") turnId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    const stream = this.conversations.responseModeFor(body) === "stream";
    const chunks: string[] = [];
    const result = await this.conversations.retry(
      conversationId,
      turnId,
      body,
      stream ? (event) => {
        chunks.push(`id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
      } : undefined,
    );
    if (result.kind === "failed") throw result.error;
    if (result.kind === "processing") {
      response.status(HttpStatus.ACCEPTED);
      return this.processingAccepted(conversationId, result.turn_id, result.client_message_id);
    }
    if (stream) {
      response.status(HttpStatus.OK);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      for (const chunk of chunks) response.write(chunk);
      response.end();
      return;
    }
    response.status(HttpStatus.OK);
    return result.result;
  }

  private processingAccepted(conversationId: string, turnId: string, clientMessageId: string) {
    return {
      contract_version: "1.0.0",
      conversation_id: conversationId,
      turn_id: turnId,
      client_message_id: clientMessageId,
      status: "PROCESSING",
      code: "MESSAGE_IN_PROGRESS",
    };
  }
}
