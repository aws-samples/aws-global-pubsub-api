import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import { Role, ServicePrincipal, PolicyDocument, PolicyStatement } from '@aws-cdk/aws-iam';

interface GlobalSubsEBRulesRegion1Props extends cdk.StackProps {
  readonly eventBus: events.IEventBus;
}

export class GlobalSubsXRegionEBRulesRegion2 extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: GlobalSubsEBRulesRegion1Props) {
    super(scope, id, props);

    const eventBridgeRegion2Role = new Role(this, 'EventBridge2EventBridgeRole', {
      assumedBy: new ServicePrincipal('events.amazonaws.com'),
      inlinePolicies: {
        invokeAPI: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: [props.eventBus.eventBusArn],
              actions: ['events:PutEvents'],
            }),
          ],
        }),
      },
    });

    const crossRegionrule = new events.CfnRule(this, 'toAppSyncRegion1', {
      name: 'toAppSyncRegion1',
      eventBusName: props.eventBus.eventBusName,
      eventPattern: {
        'source': ['appsync'],
        'detail-type': ['channel update'],
      },
      targets: [
        {
          id: 'toAppSyncRegion1',
          arn: props.eventBus.eventBusArn,
          roleArn: eventBridgeRegion2Role.roleArn
        },
      ],
    })
  }
}