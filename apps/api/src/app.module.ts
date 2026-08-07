import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { ConversationService } from "./conversation/conversation.service";
import { SqliteTurnLifecycleStore } from "./conversation/sqlite-turn-lifecycle.store";
import { SqliteMemoryService } from "./conversation/sqlite-memory.service";
import { SqliteQuoteService } from "./conversation/sqlite-quote.service";
import { openApiDatabase } from "./conversation/sqlite-runtime";
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
  SQLITE_DATABASE,
  TURN_LIFECYCLE_STORE,
} from "./conversation/tokens";
import type { ConversationRepository, TurnLifecycleStore } from "./conversation/ports";

const useInMemoryRuntime = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

const persistenceProviders = useInMemoryRuntime
  ? [{ provide: CONVERSATION_REPOSITORY, useClass: FakeConversationRepository }]
  : [
      { provide: SQLITE_DATABASE, useFactory: openApiDatabase },
      {
        provide: CONVERSATION_REPOSITORY,
        inject: [SQLITE_DATABASE],
        useFactory: (database: ConstructorParameters<typeof SqliteTurnLifecycleStore>[0]) => new SqliteTurnLifecycleStore(database),
      },
      {
        provide: TURN_LIFECYCLE_STORE,
        inject: [CONVERSATION_REPOSITORY],
        useFactory: (store: ConversationRepository) => store as unknown as TurnLifecycleStore,
      },
    ];

const memoryProvider = useInMemoryRuntime
  ? {
      provide: MEMORY_SERVICE,
      inject: [CONVERSATION_REPOSITORY],
      useFactory: (conversations: ConversationRepository) => new FakeMemoryService(conversations),
    }
  : {
      provide: MEMORY_SERVICE,
      inject: [SQLITE_DATABASE, CONVERSATION_REPOSITORY],
      useFactory: (
        database: ConstructorParameters<typeof SqliteMemoryService>[0],
        conversations: ConversationRepository,
      ) => new SqliteMemoryService(database, conversations),
    };

const quoteProvider = useInMemoryRuntime
  ? { provide: QUOTE_SERVICE, useClass: FakeQuoteService }
  : {
      provide: QUOTE_SERVICE,
      inject: [SQLITE_DATABASE],
      useFactory: (database: ConstructorParameters<typeof SqliteQuoteService>[0]) => new SqliteQuoteService(database),
    };

@Module({
  controllers: [AppController],
  providers: [
    ...persistenceProviders,
    { provide: AI_PROVIDER, useClass: FakeAiProvider },
    { provide: KNOWLEDGE_PROVIDER, useClass: FakeKnowledgeProvider },
    memoryProvider,
    quoteProvider,
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
