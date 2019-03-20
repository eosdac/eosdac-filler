const getMsigProposalsSchema = {
    description: 'Fetch msig proposals',
    summary: 'Fetch current msig proposals',
    tags: ['v1'],
    querystring: {
        type: 'object',
        properties: {
            "state": {
                description: 'Filter by current state',
                type: 'integer'
            },
            "limit": {
                description: 'Limit result count',
                type: 'integer'
            },
            "skip": {
                description: 'Skip number of results',
                type: 'integer'
            }
        },
        required: []
    }
};

module.exports = {GET:getMsigProposalsSchema}