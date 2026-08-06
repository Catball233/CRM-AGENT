import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { ConversationService } from "./conversation/conversation.service";
import {
  FakeAiProvider,
  FakeApiLogger,
  FakeConversationRepository,
  FakeKnowledgeProvider,
  FakeMemoryService,
  FakeQuoteService,
} from "./conversation/fake-adapters";
import {
  AI_PROVIDER,
  API_LOGGER,
  CONVERSATION_REPOSITORY,
  KNOWLEDGE_PROVIDER,
  MEMORY_SERVICE,
  QUOTE_SERVICE,
} from "./conversation/tokens";
import type { ConversationRepository } from "./conversation/ports";

@Module({
  controllers: [AppController],
  providers: [
    { provide: CONVERSATION_REPOSITORY, useClass: FakeConversationRepository },
    { provide: AI_PROVIDER, useClass: FakeAiProvider },
    { provide: KNOWLEDGE_PROVIDER, useClass: FakeKnowledgeProvider },
    {
      provide: MEMORY_SERVICE,
      inject: [CONVERSATION_REPOSITORY],
      useFactory: (conversations: ConversationRepository) => new FakeMemoryService(conversations),
    },
    { provide: QUOTE_SERVICE, useClass: FakeQuoteService },
    { provide: API_LOGGER, useClass: FakeApiLogger },
    ConversationService,
  ],
  exports: [
    CONVERSATION_REPOSITORY,
    AI_PROVIDER,
    KNOWLEDGE_PROVIDER,
    MEMORY_SERVICE,
    QUOTE_SERVICE,
    API_LOGGER,
    ConversationService,
  ],
})
export class AppModule {}
