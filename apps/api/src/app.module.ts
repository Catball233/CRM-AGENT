import { Module } from "@nestjs/common";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBailianKnowledgeProviderFromEnv } from "@crm-agent/knowledge-provider";
import { createBailianModelProviderFromEnv } from "@crm-agent/model-provider";
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

const workingDirectory = process.cwd();
const projectRoot = existsSync(resolve(workingDirectory, "database/scripts/sqlite.mjs"))
  ? workingDirectory
  : resolve(workingDirectory, "../..");
const environmentFile = resolve(projectRoot, ".env");
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

const useInMemoryRuntime = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const useBailianProviders = !useInMemoryRuntime && process.env.CRM_AGENT_PROVIDER_MODE !== "fake";

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

const aiProvider = !useBailianProviders
  ? { provide: AI_PROVIDER, useClass: FakeAiProvider }
  : { provide: AI_PROVIDER, useFactory: createBailianModelProviderFromEnv };

const knowledgeProvider = !useBailianProviders
  ? { provide: KNOWLEDGE_PROVIDER, useClass: FakeKnowledgeProvider }
  : { provide: KNOWLEDGE_PROVIDER, useFactory: createBailianKnowledgeProviderFromEnv };

@Module({
  controllers: [AppController],
  providers: [
    ...persistenceProviders,
    aiProvider,
    knowledgeProvider,
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
