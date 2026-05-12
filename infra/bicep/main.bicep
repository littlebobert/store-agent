param location string = resourceGroup().location
param prefix string = 'store-agent'

@description('Azure Container Registry name, for example myregistry')
param containerRegistryName string

@description('Resource group containing the Azure Container Registry')
param containerRegistryResourceGroup string = resourceGroup().name

@description('Subscription containing the Azure Container Registry')
param containerRegistrySubscriptionId string = subscription().subscriptionId

@description('API image name and tag, for example store-agent/api:latest')
param apiImage string

@description('Worker image name and tag, for example store-agent/worker:latest')
param workerImage string

@description('PostgreSQL admin login name')
param postgresAdminLogin string = 'storeagent'

@secure()
@description('PostgreSQL admin password')
param postgresAdminPassword string

param postgresSkuName string = 'Standard_B1ms'
param postgresVersion string = '16'
param serviceBusQueueName string = 'release-requests'
param slackCommandName string = '/asc'
param openAiModel string = 'gpt-5.5'
@allowed([
  'low'
  'medium'
  'high'
])
param openAiReasoningEffort string = 'high'
@allowed([
  'auto'
  'default'
  'flex'
  'scale'
  'priority'
])
param openAiServiceTier string = 'priority'
param approvalTtlMinutes int = 20

@secure()
param slackBotToken string

@secure()
param slackSigningSecret string

@secure()
param openAiApiKey string

@secure()
param ascKeyId string

@secure()
param ascIssuerId string

@secure()
param ascPrivateKeyB64 string

var uniqueSuffix = uniqueString(resourceGroup().id, prefix)
var compactPrefix = toLower(replace(prefix, '-', ''))
var keyVaultName = '${take(compactPrefix, 9)}${take(uniqueSuffix, 13)}kv'
var logAnalyticsName = '${prefix}-logs-${uniqueSuffix}'
var containerEnvName = '${prefix}-cae-${uniqueSuffix}'
var postgresName = toLower('${prefix}-${uniqueSuffix}-pg')
var postgresDbName = 'store_agent'
var postgresFqdn = '${postgresName}.postgres.database.azure.com'
var serviceBusNamespaceName = '${take(compactPrefix, 16)}-${take(uniqueSuffix, 8)}-bus'
var apiIdentityName = '${prefix}-api-id-${uniqueSuffix}'
var workerIdentityName = '${prefix}-worker-id-${uniqueSuffix}'
var apiContainerAppName = '${prefix}-api'
var workerJobName = '${prefix}-worker'
var containerRegistryServer = '${containerRegistryName}.azurecr.io'
var postgresConnectionString = 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgresFqdn}:5432/${postgresDbName}?sslmode=require'

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: apiIdentityName
  location: location
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, logAnalytics.apiVersion).primarySharedKey
      }
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: false
    enabledForDeployment: true
    enabledForTemplateDeployment: true
    enabledForDiskEncryption: false
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
  }
}

resource keyVaultAccessPolicies 'Microsoft.KeyVault/vaults/accessPolicies@2023-07-01' = {
  name: 'add'
  parent: keyVault
  properties: {
    accessPolicies: [
      {
        tenantId: tenant().tenantId
        objectId: apiIdentity.properties.principalId
        permissions: {
          secrets: [
            'get'
            'list'
          ]
        }
      }
      {
        tenantId: tenant().tenantId
        objectId: workerIdentity.properties.principalId
        permissions: {
          secrets: [
            'get'
            'list'
          ]
        }
      }
    ]
  }
}

resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: serviceBusNamespaceName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
}

resource serviceBusQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: serviceBusQueueName
  parent: serviceBusNamespace
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    deadLetteringOnMessageExpiration: true
  }
}

var serviceBusConnectionString = listKeys(
  resourceId('Microsoft.ServiceBus/namespaces/AuthorizationRules', serviceBusNamespace.name, 'RootManageSharedAccessKey'),
  '2022-10-01-preview'
).primaryConnectionString

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: postgresName
  location: location
  sku: {
    name: postgresSkuName
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: postgresVersion
    createMode: 'Default'
    network: {
      publicNetworkAccess: 'Enabled'
    }
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  name: postgresDbName
  parent: postgresServer
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  name: 'AllowAzureServices'
  parent: postgresServer
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource slackBotTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'slack-bot-token'
  parent: keyVault
  properties: {
    value: slackBotToken
  }
}

resource slackSigningSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'slack-signing-secret'
  parent: keyVault
  properties: {
    value: slackSigningSecret
  }
}

resource openAiApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'openai-api-key'
  parent: keyVault
  properties: {
    value: openAiApiKey
  }
}

resource ascKeyIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'asc-key-id'
  parent: keyVault
  properties: {
    value: ascKeyId
  }
}

resource ascIssuerIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'asc-issuer-id'
  parent: keyVault
  properties: {
    value: ascIssuerId
  }
}

resource ascPrivateKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'asc-private-key-b64'
  parent: keyVault
  properties: {
    value: ascPrivateKeyB64
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'database-url'
  parent: keyVault
  properties: {
    value: postgresConnectionString
  }
}

resource serviceBusConnectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'service-bus-connection'
  parent: keyVault
  properties: {
    value: serviceBusConnectionString
  }
}

module apiIdentityAcrPull './modules/acr-pull-role.bicep' = {
  name: 'api-acr-pull-assignment'
  scope: resourceGroup(containerRegistrySubscriptionId, containerRegistryResourceGroup)
  params: {
    containerRegistryName: containerRegistryName
    principalId: apiIdentity.properties.principalId
    principalResourceId: apiIdentity.id
  }
}

module workerIdentityAcrPull './modules/acr-pull-role.bicep' = {
  name: 'worker-acr-pull-assignment'
  scope: resourceGroup(containerRegistrySubscriptionId, containerRegistryResourceGroup)
  params: {
    containerRegistryName: containerRegistryName
    principalId: workerIdentity.properties.principalId
    principalResourceId: workerIdentity.id
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiContainerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: containerRegistryServer
          identity: apiIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: databaseUrlSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'service-bus-connection'
          keyVaultUrl: serviceBusConnectionSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'slack-bot-token'
          keyVaultUrl: slackBotTokenSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'slack-signing-secret'
          keyVaultUrl: slackSigningSecretSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: openAiApiKeySecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'asc-key-id'
          keyVaultUrl: ascKeyIdSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'asc-issuer-id'
          keyVaultUrl: ascIssuerIdSecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
        {
          name: 'asc-private-key-b64'
          keyVaultUrl: ascPrivateKeySecret.properties.secretUriWithVersion
          identity: apiIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${containerRegistryServer}/${apiImage}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'SERVICE_BUS_CONNECTION_STRING'
              secretRef: 'service-bus-connection'
            }
            {
              name: 'SERVICE_BUS_QUEUE_NAME'
              value: serviceBusQueueName
            }
            {
              name: 'SLACK_BOT_TOKEN'
              secretRef: 'slack-bot-token'
            }
            {
              name: 'SLACK_SIGNING_SECRET'
              secretRef: 'slack-signing-secret'
            }
            {
              name: 'SLACK_COMMAND_NAME'
              value: slackCommandName
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'OPENAI_MODEL'
              value: openAiModel
            }
            {
              name: 'OPENAI_REASONING_EFFORT'
              value: openAiReasoningEffort
            }
            {
              name: 'OPENAI_SERVICE_TIER'
              value: openAiServiceTier
            }
            {
              name: 'APPROVAL_TTL_MINUTES'
              value: string(approvalTtlMinutes)
            }
            {
              name: 'ASC_PATH'
              value: 'asc'
            }
            {
              name: 'ASC_KEY_ID'
              secretRef: 'asc-key-id'
            }
            {
              name: 'ASC_ISSUER_ID'
              secretRef: 'asc-issuer-id'
            }
            {
              name: 'ASC_PRIVATE_KEY_B64'
              secretRef: 'asc-private-key-b64'
            }
            {
              name: 'ASC_BYPASS_KEYCHAIN'
              value: '1'
            }
            {
              name: 'ASC_NO_UPDATE'
              value: '1'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: workerJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Event'
      registries: [
        {
          server: containerRegistryServer
          identity: workerIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: databaseUrlSecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'service-bus-connection'
          keyVaultUrl: serviceBusConnectionSecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'slack-bot-token'
          keyVaultUrl: slackBotTokenSecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'openai-api-key'
          keyVaultUrl: openAiApiKeySecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'asc-key-id'
          keyVaultUrl: ascKeyIdSecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'asc-issuer-id'
          keyVaultUrl: ascIssuerIdSecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
        {
          name: 'asc-private-key-b64'
          keyVaultUrl: ascPrivateKeySecret.properties.secretUriWithVersion
          identity: workerIdentity.id
        }
      ]
      eventTriggerConfig: {
        replicaCompletionCount: 1
        parallelism: 1
        scale: {
          minExecutions: 0
          maxExecutions: 5
          pollingInterval: 30
          rules: [
            {
              name: 'service-bus-queue'
              type: 'azure-servicebus'
              metadata: {
                queueName: serviceBusQueueName
                namespace: serviceBusNamespace.name
                messageCount: '1'
              }
              auth: [
                {
                  secretRef: 'service-bus-connection'
                  triggerParameter: 'connection'
                }
              ]
            }
          ]
        }
      }
      replicaRetryLimit: 0
      replicaTimeout: 1800
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${containerRegistryServer}/${workerImage}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'SLACK_BOT_TOKEN'
              secretRef: 'slack-bot-token'
            }
            {
              name: 'SERVICE_BUS_CONNECTION_STRING'
              secretRef: 'service-bus-connection'
            }
            {
              name: 'SERVICE_BUS_QUEUE_NAME'
              value: serviceBusQueueName
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'OPENAI_MODEL'
              value: openAiModel
            }
            {
              name: 'OPENAI_REASONING_EFFORT'
              value: openAiReasoningEffort
            }
            {
              name: 'OPENAI_SERVICE_TIER'
              value: openAiServiceTier
            }
            {
              name: 'ASC_PATH'
              value: 'asc'
            }
            {
              name: 'ASC_KEY_ID'
              secretRef: 'asc-key-id'
            }
            {
              name: 'ASC_ISSUER_ID'
              secretRef: 'asc-issuer-id'
            }
            {
              name: 'ASC_PRIVATE_KEY_B64'
              secretRef: 'asc-private-key-b64'
            }
            {
              name: 'ASC_BYPASS_KEYCHAIN'
              value: '1'
            }
            {
              name: 'ASC_NO_UPDATE'
              value: '1'
            }
          ]
        }
      ]
    }
  }
}

output apiUrl string = 'https://${apiApp.properties.configuration.ingress.fqdn}'
output keyVaultUri string = keyVault.properties.vaultUri
output serviceBusNamespace string = serviceBusNamespace.name
output serviceBusQueue string = serviceBusQueue.name
output postgresHost string = postgresFqdn
output postgresDatabase string = postgresDatabase.name
