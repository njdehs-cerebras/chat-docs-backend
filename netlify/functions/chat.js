const axios = require('axios');
const Cerebras = require('@cerebras/cerebras_cloud_sdk').default;

// Initialize Cerebras client
const cerebrasClient = new Cerebras({
    apiKey: process.env.CEREBRAS_API_KEY
});

// MCP server URL for Cerebras training docs
const MCP_SERVER_URL = 'https://training-docs.cerebras.ai/mcp';

// Helper function to parse SSE responses
function parseSSEResponse(sseData) {
    if (!sseData || typeof sseData !== 'string') return null;
    
    // Extract JSON from SSE format
    const lines = sseData.split('\n');
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            try {
                return JSON.parse(line.substring(6));
            } catch (e) {
                console.error('Failed to parse SSE data:', e);
            }
        }
    }
    return null;
}

// Function to connect to MCP server and search docs
async function searchCerebrasDocs(query) {
    try {
        console.log('Attempting to connect to MCP server at:', MCP_SERVER_URL);
        
        // First, we need to initialize the MCP connection
        const initResponse = await axios.post(MCP_SERVER_URL, {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'cerebras-docs-chatbot',
                    version: '1.0.0'
                }
            },
            id: 1
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            }
        });
        
        // Parse SSE response
        const initData = parseSSEResponse(initResponse.data);
        console.log('MCP init response:', JSON.stringify(initData, null, 2));
        
        // List available tools
        const toolsResponse = await axios.post(MCP_SERVER_URL, {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 2
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            }
        });
        
        // Parse SSE response for tools
        const toolsData = parseSSEResponse(toolsResponse.data);
        console.log('Available MCP tools:', JSON.stringify(toolsData, null, 2));
        
        // Now call the search tool
        const searchResponse = await axios.post(MCP_SERVER_URL, {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'search',
                arguments: {
                    query: query
                }
            },
            id: 3
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            }
        });

        // Parse SSE response for search
        const searchData = parseSSEResponse(searchResponse.data);
        console.log('MCP search response:', JSON.stringify(searchData, null, 2));
        
        if (searchData && searchData.result && searchData.result.content) {
            // Extract all text content from the search results
            const contents = searchData.result.content;
            if (Array.isArray(contents)) {
                const textContent = contents
                    .filter(item => item.type === 'text' && item.text)
                    .map(item => item.text)
                    .join('\n\n---\n\n');
                
                console.log('Extracted text content length:', textContent.length);
                return textContent;
            }
        }
        
        return "No relevant documentation found for your query.";
    } catch (error) {
        console.error('Error searching docs via MCP:', error.message);
        if (error.response) {
            console.error('MCP error response status:', error.response.status);
            console.error('MCP error response data:', JSON.stringify(error.response.data, null, 2));
        }
        
        // Return null to indicate MCP failed
        return null;
    }
}

// Function to analyze search results and pick relevant URLs
async function analyzeSearchResults(userQuery, searchResults) {
    try {
        // Parse the search results to extract URLs
        const searchItems = [];
        const lines = searchResults.split('\n');
        let currentItem = {};
        
        for (const line of lines) {
            if (line.startsWith('Title:')) {
                if (currentItem.title) searchItems.push(currentItem);
                currentItem = { title: line.substring(6).trim() };
            } else if (line.startsWith('Link:')) {
                currentItem.link = line.substring(5).trim();
            } else if (line.startsWith('Content:')) {
                currentItem.content = line.substring(8).trim();
            }
        }
        if (currentItem.title) searchItems.push(currentItem);
        
        console.log(`Found ${searchItems.length} search results`);
        
        // Ask LLM to analyze which pages are most relevant
        const analysisPrompt = `Based on the user's question and the search results below, identify which documentation pages would be most relevant to fetch in full. Return ONLY a JSON array of URLs (maximum 3) that would best help answer the question.

User Question: "${userQuery}"

Search Results:
${searchItems.map((item, i) => `
${i + 1}. Title: ${item.title}
   URL: ${item.link}
   Summary: ${item.content}
`).join('\n')}

Return ONLY a JSON array of URLs, like: ["url1", "url2"]
If none are relevant enough to fetch, return: []`;

        const analysisResponse = await cerebrasClient.chat.completions.create({
            model: 'qwen-3-235b-a22b-instruct-2507',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant that analyzes search results. Return only valid JSON arrays.'
                },
                {
                    role: 'user',
                    content: analysisPrompt
                }
            ],
            temperature: 0.3,
            max_tokens: 200
        });
        
        const urlsText = analysisResponse.choices[0].message.content.trim();
        console.log('LLM selected URLs:', urlsText);
        
        try {
            // Extract JSON array from the response
            const jsonMatch = urlsText.match(/\[.*\]/s);
            if (jsonMatch) {
                const urls = JSON.parse(jsonMatch[0]);
                return Array.isArray(urls) ? urls.slice(0, 3) : [];
            }
        } catch (e) {
            console.error('Failed to parse URL selection:', e);
        }
        
        return [];
    } catch (error) {
        console.error('Error analyzing search results:', error);
        return [];
    }
}

// Function to fetch full content from URLs
async function fetchFullContent(urls) {
    try {
        const contents = [];
        
        for (const url of urls) {
            try {
                console.log('Fetching:', url);
                const response = await axios.get(url, {
                    headers: {
                        'Accept': 'text/html,application/json',
                        'User-Agent': 'Cerebras-Docs-Chatbot/1.0'
                    },
                    timeout: 5000
                });
                
                if (response.data) {
                    // Extract text content from HTML
                    let content = typeof response.data === 'string' 
                        ? response.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
                        : JSON.stringify(response.data);
                    
                    // Limit content length per page
                    content = content.substring(0, 10000);
                    
                    contents.push(`\n\n=== Content from ${url} ===\n${content}\n`);
                }
            } catch (fetchError) {
                console.error(`Failed to fetch ${url}:`, fetchError.message);
            }
        }
        
        return contents.length > 0 ? contents.join('\n---\n') : null;
    } catch (error) {
        console.error('Error fetching full content:', error);
        return null;
    }
}

// Function to call Cerebras API
async function getCerebrasResponse(message, context) {
    try {
        let systemPrompt = `You are a helpful assistant that answers questions about the Cerebras Platform.`;
        
        if (context && context !== null) {
            systemPrompt += `\n\nUse the following context from the official Cerebras documentation to answer the user's question accurately:\n\n${context}\n\nBase your answer primarily on this documentation.`;
        } else {
            systemPrompt += `\n\nNote: I couldn't access the MCP server at this moment. Please inform the user that the documentation server is unavailable and you cannot provide specific information from the docs.`;
        }
        
        const chatCompletion = await cerebrasClient.chat.completions.create({
            model: 'qwen-3-235b-a22b-instruct-2507',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: message
                }
            ],
            temperature: 0.7,
            max_tokens: 1000
        });

        if (chatCompletion.choices && chatCompletion.choices[0]) {
            return chatCompletion.choices[0].message.content;
        }
        
        throw new Error('Invalid response from Cerebras API');
    } catch (error) {
        console.error('Error calling Cerebras API:', error);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
}

// Netlify function handler
exports.handler = async (event, context) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { message } = JSON.parse(event.body);
        
        if (!message) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ error: 'Message is required' })
            };
        }

        // Step 1: Search the docs first via MCP
        console.log('Step 1: Searching docs for:', message);
        const searchResults = await searchCerebrasDocs(message);
        
        if (!searchResults) {
            console.log('No search results found');
            const response = await getCerebrasResponse(message, null);
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ response })
            };
        }
        
        // Step 2: Ask LLM to analyze search results and pick relevant pages
        console.log('Step 2: Analyzing search results to find most relevant pages...');
        const relevantUrls = await analyzeSearchResults(message, searchResults);
        
        // Step 3: Fetch full content from selected pages
        let fullContext = searchResults; // Default to search summaries
        if (relevantUrls && relevantUrls.length > 0) {
            console.log('Step 3: Fetching full content from:', relevantUrls);
            const fullContent = await fetchFullContent(relevantUrls);
            if (fullContent) {
                fullContext = fullContent;
            }
        }
        
        // Step 4: Get final response from Cerebras using the context
        console.log('Step 4: Getting final Cerebras response...');
        console.log('Context length:', fullContext.length, 'characters');
        const response = await getCerebrasResponse(message, fullContext);
        
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ response })
        };
        
    } catch (error) {
        console.error('Error in chat handler:', error);
        console.error('Full error details:', JSON.stringify(error, null, 2));
        
        let errorMessage = 'I apologize, but I encountered an error. ';
        
        if (error.message && error.message.includes('401')) {
            errorMessage += 'Please check that your Cerebras API key is valid.';
        } else if (error.message && error.message.includes('model')) {
            errorMessage += 'There might be an issue with the model selection.';
        } else {
            errorMessage += 'Please try again later or check the server logs for more details.';
        }
        
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                error: 'Failed to process request',
                response: errorMessage
            })
        };
    }
};