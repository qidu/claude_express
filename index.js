import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 8787;

// 中间件
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Anthropic-Version']
}));

app.use(express.json());

// 环境变量配置 .env
const config = {
  HAIKU_MODEL_NAME: process.env.HAIKU_MODEL_NAME || 'gpt-oss-120b',
  HAIKU_BASE_URL: process.env.HAIKU_BASE_URL || 'https://openai.qiniu.com/v1',
  HAIKU_API_KEY: process.env.HAIKU_API_KEY || 'sk-d8d563c410cd87a6c29dc81bf983aa935a16fe27166a8eb0444c1324ec******'
};
// console.log(config.HAIKU_MODEL_NAME)
// console.log(config.HAIKU_BASE_URL)
// console.log(config.HAIKU_API_KEY)

// --- 辅助函数 ---

/**
 * 从路径解析模型和基础 URL
 */
function parsePathAndModel(pathname) {
  const dynamicPath = pathname.substring(0, pathname.lastIndexOf('/v1/messages'));
  const parts = dynamicPath.split('/').filter(p => p);

  if (parts.length < 2) {
    return null;
  }

  const modelName = parts.pop();
  let baseUrl;

  if (parts[0].toLowerCase() === 'http' || parts[0].toLowerCase() === 'https') {
    const scheme = parts.shift();
    baseUrl = `${scheme}://${parts.join('/')}`;
  } else {
    baseUrl = `https://${parts.join('/')}`;
  }

  return { baseUrl, modelName };
}

/**
 * 递归清理 JSON Schema
 */
function recursivelyCleanSchema(schema) {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => recursivelyCleanSchema(item));
  }

  const newSchema = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      if (key === '$schema' || key === 'additionalProperties') {
        continue;
      }
      newSchema[key] = recursivelyCleanSchema(schema[key]);
    }
  }

  if (newSchema.type === 'string' && newSchema.format) {
    const supportedFormats = ['date-time', 'enum'];
    if (!supportedFormats.includes(newSchema.format)) {
      delete newSchema.format;
    }
  }

  return newSchema;
}

/**
 * 转换 Claude 请求到 OpenAI 格式
 */
function convertClaudeToOpenAIRequest(claudeRequest, modelName) {
  const openaiMessages = [];

  if (claudeRequest.system) {
    openaiMessages.push({ role: "system", content: claudeRequest.system });
  }

  for (let i = 0; i < claudeRequest.messages.length; i++) {
    const message = claudeRequest.messages[i];
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        const toolResults = message.content.filter(c => c.type === 'tool_result');
        const otherContent = message.content.filter(c => c.type !== 'tool_result');

        if (toolResults.length > 0) {
          toolResults.forEach(block => {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          });
        }

        if (otherContent.length > 0) {
          openaiMessages.push({ 
            role: "user", 
            content: otherContent.map(block => 
              block.type === 'text' 
                ? { type: 'text', text: block.text } 
                : { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
            )
          });
        }
      } else {
        openaiMessages.push({ role: "user", content: message.content });
      }
    } else if (message.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      if (Array.isArray(message.content)) {
        message.content.forEach(block => {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          }
        });
      }
      const assistantMessage = { 
        role: 'assistant', 
        content: textParts.join('\n') || null
      };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      openaiMessages.push(assistantMessage);
    }
  }

  const openaiRequest = {
    model: modelName,
    messages: openaiMessages,
    max_tokens: claudeRequest.max_tokens,
    temperature: claudeRequest.temperature,
    top_p: claudeRequest.top_p,
    stream: claudeRequest.stream,
    stop: claudeRequest.stop_sequences,
  };

  if (claudeRequest.tools) {
    openaiRequest.tools = claudeRequest.tools.map((tool) => {
      const cleanedParameters = recursivelyCleanSchema(tool.input_schema);
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: cleanedParameters,
        },
      };
    });
  }

  if (claudeRequest.tool_choice) {
    if (claudeRequest.tool_choice.type === 'auto' || claudeRequest.tool_choice.type === 'any') {
      openaiRequest.tool_choice = 'auto';
    } else if (claudeRequest.tool_choice.type === 'tool') {
      openaiRequest.tool_choice = { 
        type: 'function', 
        function: { name: claudeRequest.tool_choice.name } 
      };
    }
  }

  return openaiRequest;
}

/**
 * 转换 OpenAI 响应到 Claude 格式
 */
function convertOpenAIToClaudeResponse(openaiResponse, model) {
  const choice = openaiResponse.choices[0];
  const contentBlocks = [];
  if (choice.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    choice.message.tool_calls.forEach((call) => {
      contentBlocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      });
    });
  }
  const stopReasonMap = { 
    stop: "end_turn", 
    length: "max_tokens", 
    tool_calls: "tool_use" 
  };
  return {
    id: openaiResponse.id,
    type: "message",
    role: "assistant",
    model: model,
    content: contentBlocks,
    stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
    },
  };
}

/**
 * 处理流式响应
 */
async function handleStreamResponse(openaiResponse, model, res) {
  const messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
  const toolCalls = {};
  let contentBlockIndex = 0;

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 发送初始事件
  sendEvent('message_start', { 
    type: 'message_start', 
    message: { 
      id: messageId, 
      type: 'message', 
      role: 'assistant', 
      model, 
      content: [], 
      stop_reason: null, 
      usage: { input_tokens: 0, output_tokens: 0 } 
    } 
  });
  sendEvent('content_block_start', { 
    type: 'content_block_start', 
    index: 0, 
    content_block: { type: 'text', text: '' } 
  });

  // 处理流式数据
  openaiResponse.body.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      
      const data = line.substring(6).trim();
      if (data === '[DONE]') {
        sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
        
        Object.values(toolCalls).forEach(tc => {
          if (tc.started) {
            sendEvent('content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
          }
        });
        
        sendEvent('message_delta', { 
          type: 'message_delta', 
          delta: { stop_reason: "end_turn", stop_sequence: null }, 
          usage: { output_tokens: 0 } 
        });
        sendEvent('message_stop', { type: 'message_stop' });
        
        res.end();
        return;
      }
      
      try {
        const openaiChunk = JSON.parse(data);
        const delta = openaiChunk.choices[0]?.delta;
        if (!delta) continue;
        
        if (delta.content) {
          sendEvent('content_block_delta', { 
            type: 'content_block_delta', 
            index: 0, 
            delta: { type: 'text_delta', text: delta.content } 
          });
        }
        
        if (delta.tool_calls) {
          for (const tc_delta of delta.tool_calls) {
            const index = tc_delta.index;
            if (!toolCalls[index]) {
              toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false };
            }
            
            if (tc_delta.id) toolCalls[index].id = tc_delta.id;
            if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
            if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;
            
            if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
              contentBlockIndex++;
              toolCalls[index].claudeIndex = contentBlockIndex;
              toolCalls[index].started = true;
              
              sendEvent('content_block_start', { 
                type: 'content_block_start', 
                index: contentBlockIndex, 
                content_block: { 
                  type: 'tool_use', 
                  id: toolCalls[index].id, 
                  name: toolCalls[index].name, 
                  input: {} 
                } 
              });
            }
            
            if (toolCalls[index].started && tc_delta.function?.arguments) {
              sendEvent('content_block_delta', { 
                type: 'content_block_delta', 
                index: toolCalls[index].claudeIndex, 
                delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments } 
              });
            }
          }
        }
      } catch (e) {
        // 忽略 JSON 解析错误
      }
    }
  });

  openaiResponse.body.on('end', () => {
    res.end();
  });
}

// --- 路由处理 ---

app.post('*', async (req, res) => {
  try {
    const url = req.originalUrl;

    // console.log(url)
    for (const key in req.headers) {
      if (req.headers.hasOwnProperty(key)) {
      //  console.log(`${key}: ${req.headers[key]}`);
      }
    }
    
    // 所有有效请求必须以 /v1/messages 结尾
    if (!url.endsWith('/v1/messages') && !url.endsWith('/v1/messages?beta=true')) {
      return res.status(404).json({ error: 'Not Found. URL must end with /v1/messages' });
    }

    const authtoken = req.headers['authorization'] || req.headers['Authorization'];
    const apiKey = req.headers['x-api-key'] || (authtoken && authtoken.substring(authtoken.lastIndexOf(' ') + 1));
    
    const claudeRequest = req.body;

    // 配置选择
    let targetApiKey;
    let targetModelName;
    let targetBaseUrl;

    // 检查是否为 "haiku" 特定路由
    const isHaiku = claudeRequest.model.toLowerCase().includes("haiku");
    if (isHaiku) {
      targetModelName = config.HAIKU_MODEL_NAME;
      targetBaseUrl = config.HAIKU_BASE_URL;
      targetApiKey = config.HAIKU_API_KEY;
    } else {
      // 尝试从动态路径解析 base URL 和 model
      const dynamicConfig = parsePathAndModel(url);
      if (dynamicConfig) {
        targetBaseUrl = dynamicConfig.baseUrl;
        targetModelName = dynamicConfig.modelName;
        targetApiKey = apiKey || '';
      } else if (claudeRequest.model) {
        targetBaseUrl = config.HAIKU_BASE_URL;
        targetModelName = claudeRequest.model;
        targetApiKey = apiKey || '';
      } else {
        return res.status(400).json({ error: 'Could not determine target configuration from URL path' });
      }
    }

    if (!targetBaseUrl || !targetModelName) {
      return res.status(400).json({ 
        error: 'Could not determine target base URL or model name' 
      });
    }

    const target = {
      modelName: targetModelName,
      baseUrl: targetBaseUrl,
      apiKey: targetApiKey,
    };

    const openaiRequest = convertClaudeToOpenAIRequest(claudeRequest, target.modelName);

    // 发送请求到目标 API
    const openaiApiResponse = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(openaiRequest),
    });

    if (!openaiApiResponse.ok) {
      const errorBody = await openaiApiResponse.text();
      return res.status(openaiApiResponse.status).send(errorBody);
    }

    if (claudeRequest.stream) {
      // 设置流式响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // 处理流式响应
      await handleStreamResponse(openaiApiResponse, claudeRequest.model, res);
    } else {
      const openaiResponse = await openaiApiResponse.json();
      const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse, claudeRequest.model);
      res.json(claudeResponse);
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: error.message });
  }
});

// 处理 OPTIONS 请求
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Anthropic-Version');
  res.sendStatus(200);
});

// 启动服务器
app.listen(port, () => {
  console.log(`Claude-to-OpenAI proxy server running on port ${port}`);
});

// STOP
// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: Closing HTTP server');
  // Close the server and allow existing connections to finish
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });
});

export default app;
