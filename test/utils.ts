export const permitCreateObjRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:test.Test' }],
    subject: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'PERMIT'
};

export const denyCreateObjRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:test.Test' }],
    subject: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'user-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'DENY'
};

export const bucketPolicySetRQ = {
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'bucket_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'bucket_test_policy_id',
          target: {
            action: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:test.Test'
            }],
            subject: []
          }, effect: '',
          rules: [],
          has_rules: true
        }]
    }]
};