import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import { GraphqlApi, AuthorizationType, Directive, ObjectType, GraphqlType, ResolvableField, Field, MappingTemplate } from '@aws-cdk/aws-appsync';
import { Role, ServicePrincipal, PolicyDocument, PolicyStatement } from '@aws-cdk/aws-iam';

export class GlobalSubsRegion1 extends cdk.Stack {

  public readonly eventBus: events.IEventBus;
  
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Setting up GraphQL API

    const api = new GraphqlApi(this, 'Api', {
      name: 'GlobalWS-API',
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AuthorizationType.API_KEY,
        },
        additionalAuthorizationModes: [{
          authorizationType: AuthorizationType.IAM
        }]
      }
    });

    // Defining data types (Code-first GraphQL) - Messages are sent to channels by name

    const channel = new ObjectType('Channel', {
      directives: [Directive.iam(),Directive.apiKey()],
      definition: {
        name: GraphqlType.string({ isRequired: true }),
        message: GraphqlType.string({ isRequired: true }),
      },
    });

    api.addType(channel);

    // Configuring Event Bridge as AppSync Data Source

    const endpoint = "https://events." + this.region + ".amazonaws.com/";
    const httpdatasource = api.addHttpDataSource('events', endpoint, {
      authorizationConfig: { signingRegion: this.region, signingServiceName: 'events' },
    });

    // Adding None/Local AppSync Data Source

    const pubsub = api.addNoneDataSource('pubsub');

    // Setting up AppSync IAM Role to add events to Event Bridge

    const appsyncEventBridgeRole = new Role(this, "AppSyncEventBridgeRole", {
      assumedBy: new ServicePrincipal("appsync.amazonaws.com")
    });

    appsyncEventBridgeRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: ["events:PutEvents"]
      })
    );

    // Defining API Operations

    api.addQuery('getChannel', new Field({
      returnType: channel.attribute()
    }));

    // Clients publish messages to channels which are sent to Event Bridge - Frontend operation 

    api.addMutation('publish', new ResolvableField({
      returnType: channel.attribute(),
      args: { name: GraphqlType.string({ isRequired: true }), message: GraphqlType.string({ isRequired: true }) },
      dataSource: httpdatasource,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
          "version": "2018-05-29",
          "method": "POST",
          "resourcePath": "/",
          "params": {
            "headers": {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "AWSEvents.PutEvents"
            },
            "body": {
              "Entries":[
                {
                  "Source": "appsync",
                  "EventBusName": "AppSyncEventBus",
                  "Detail": "{ \\\"name\\\": \\\"$ctx.arguments.name\\\",\\\"message\\\": \\\"$ctx.arguments.message\\\"}",
                  "DetailType": "channel update"
                }
              ]
            }
          }
        }`
      ),
      responseMappingTemplate: MappingTemplate.fromString(`
        ## Raise a GraphQL field error in case of a datasource invocation error
        #if($ctx.error)
          $util.error($ctx.error.message, $ctx.error.type)
        #end
        ## if the response status code is not 200, then return an error. Else return the body **
        #if($ctx.result.statusCode == 200)
            ## If response is 200, return the body.
            {
              "name": "$ctx.args.name",
              "message": "$ctx.args.message"
            }
        #else
            ## If response is not 200, append the response to error block.
            $utils.appendError($ctx.result.body, "$ctx.result.statusCode")
        #end
      `)
    }))

    // Event Bridge publishes messages received in the Event Bus - Backend only operation

    api.addMutation('publishFromBus', new ResolvableField({
      returnType: channel.attribute(),
      args: { name: GraphqlType.string({ isRequired: true }), message: GraphqlType.string({ isRequired: true }) },
      dataSource: pubsub,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "payload": {
              "name": "$context.arguments.name",
              "message": "$context.arguments.message"
          }
        }`
      ),
      responseMappingTemplate: MappingTemplate.fromString(`$util.toJson($context.result)`)
    }))


    // Clients subscribe to channels by name and receive messages published to the channel

    api.addSubscription('subscribe', new ResolvableField({
      returnType: channel.attribute(),
      args: { name: GraphqlType.string({ isRequired: true }) },
      directives: [Directive.subscribe('publishFromBus')],
      dataSource: pubsub,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "payload": {
              "name": "demo",
              "message": "AppSync enhanced filtering and invalidation"
          }
        }`
      ),
      // Setting up filters 
      responseMappingTemplate: MappingTemplate.fromString(`
        $extensions.setSubscriptionFilter({
          "filterGroup": [
            {
              "filters" : [
                {
                  "fieldName" : "name",
                  "operator" : "in",
                  "value" : ["cars","robots","tech","music","media"]
                }
              ]
            }
          ]
        })
        $extensions.setSubscriptionInvalidationFilter({
            "filterGroup": [
              {
                "filters" : [
                  {
                    "fieldName" : "name",
                    "operator" : "eq",
                    "value" : $context.args.name
                  }
                ]
              }
            ]
          })
        $util.toJson($context.result)
        `)
    }));

    // Operation to unsubscribe all clients in a given channel

    api.addMutation('unsubscribe', new ResolvableField({
      returnType: channel.attribute(),
      args: { name: GraphqlType.string({ isRequired: true }) },
      directives: [Directive.iam()],
      dataSource: pubsub,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
          "version": "2017-02-28",
          "payload": {
              "name": "$context.arguments.name"
          }
        }`
      ),
      responseMappingTemplate: MappingTemplate.fromString(`
        $extensions.invalidateSubscriptions({
            "subscriptionField": "subscribe",
            "payload": {
              "name": $context.arguments.name
            }
          })    
        $util.toJson($context.result)
      `)
    }))


    // Setting up Event Bus and granting access to AppSync

    this.eventBus = new events.EventBus(this, 'bus', {
      eventBusName: 'AppSyncEventBus'
    });
    this.eventBus.grantPutEventsTo(httpdatasource.grantPrincipal);

    // Configuring AppSync as Event Bridge API Destination

    const connection = new events.CfnConnection(this, 'AppSyncConnection', {
      authorizationType: 'API_KEY',
      authParameters: {
        apiKeyAuthParameters: {
          apiKeyName: 'x-api-key',
          apiKeyValue: api.apiKey!,
        },
      },
    })

    const destination = new events.CfnApiDestination(this, 'AppSyncDestination', {
      connectionArn: connection.attrArn,
      httpMethod: 'POST',
      invocationEndpoint: api.graphqlUrl,
    })

    const eventBridgeAppSyncRole = new Role(this, 'EventBridgeAppSyncRole', {
      assumedBy: new ServicePrincipal('events.amazonaws.com'),
      inlinePolicies: {
        invokeAPI: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: [`arn:aws:events:${this.region}:${this.account}:api-destination/${destination.ref}/*`],
              actions: ['events:InvokeApiDestination'],
            }),
          ],
        }),
      },
    });

    const appSyncPublishrule = new events.CfnRule(this, 'AppSyncRule', {
      description: 'AppSync rule',
      name: 'appsync-rule',
      eventBusName: this.eventBus.eventBusName,
      eventPattern: {
        'source': ['appsync'],
        'detail-type': ['channel update'],
      },
      targets: [
        {
          id: 'default-target-appsync',
          arn: destination.attrArn,
          roleArn: eventBridgeAppSyncRole.roleArn,
          inputTransformer: {
            inputPathsMap: {
              name: '$.detail.name',
              message: '$.detail.message',
            },
            inputTemplate: `{
              "query": "mutation PublishFromBus($name:String!, $message:String!) {
                publishFromBus(name:$name, message:$message) { name message }
              }",
              "operationName": "PublishFromBus",
              "variables": {
                "name": "<name>",
                "message": "<message>"
              }
            }`.replace(/\n\s*/g, ' '),
          },
        },
      ],
    })

   // Outputs

    new cdk.CfnOutput(this, 'graphqlUrl', { value: api.graphqlUrl })
    new cdk.CfnOutput(this, 'apiKey', { value: api.apiKey! })
    new cdk.CfnOutput(this, 'apiId', { value: api.apiId })
    new cdk.CfnOutput(this, 'eventBus', { value: this.eventBus.eventBusArn })
    new cdk.CfnOutput(this, 'region', { value: this.region })

  }
}