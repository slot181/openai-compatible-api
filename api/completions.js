// completions.js

// 处理错误并返回格式化后的错误信息
function handleError(error) {
  console.error('Error details:', error);

  if (error.response) {
    return {
      error: {
        message: error.response.data?.error?.message || error.message,
        type: "api_error",
        code: error.response.status,
        provider_error: error.response.data,
        path: error.config?.url,
        method: error.config?.method
      }
    };
  }

  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return {
      error: {
        message: "Provider service is unavailable",
        type: "connection_error",
        code: 503,
        details: error.message
      }
    };
  }

  return {
    error: {
      message: error.message,
      type: "internal_error",
      code: 500
    }
  };
}

const axios = require('axios');

// 审核模型的系统提示语
const DEFAULT_SYSTEM_CONTENT = `你是一个内容审核助手,负责对文本和图片内容进行安全合规审核。你需要重点识别和判断以下违规内容:
- 色情和暴露内容
- 恐怖暴力内容
- 违法违规内容(如毒品、赌博等)
# OBJECTIVE #
对用户提交的文本或图片进行内容安全审查,检测是否包含色情、暴力、违法等违规内容,并输出布尔类型的审核结果。
如果消息中包含图片，请仔细分析图片内容。
# STYLE #
- 简洁的
- 直接的
- 标准JSON格式
# TONE #
- 严格的
- 客观的
# RESPONSE #
请仅返回如下JSON格式:
{
    "isViolation": false  // 含有色情/暴力/违法内容返回true,否则返回false
}`;

// 验证消息格式的工具函数
function validateMessage(message) {
  if (!message.role || typeof message.role !== 'string') {
    return false;
  }
  if (!message.content) {
    return false;
  }

  // 处理数组格式的 content
  if (Array.isArray(message.content)) {
    return message.content.every(item => {
      if (item.type === 'text') {
        return typeof item.text === 'string';
      }
      if (item.type === 'image_url') {
        if (typeof item.image_url === 'string') {
          // 验证URL格式
          if (!item.image_url.match(/^https?:\/\/.+/)) {
            return false;
          }
          // 验证图片格式
          if (!item.image_url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            return false;
          }
          return true;
        } else if (typeof item.image_url === 'object' && typeof item.image_url.url === 'string') {
          const url = item.image_url.url;
          // 支持 base64 格式的图片
          if (url.startsWith('data:image/') && url.includes(';base64,')) {
            return true;
          }
          // 验证普通 URL 格式
          if (!url.match(/^https?:\/\/.+/)) {
            return false;
          }
          // 验证图片格式
          if (!url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            return false;
          }
          return true;
        }
        return false;
      }
      return false;
    });
  }

  // 如果是字符串格式的 content
  if (typeof message.content === 'string') {
    // 必须是严格的 JSON 格式
    try {
      const parsedContent = JSON.parse(message.content);
      // 验证解析后的 JSON 是否为对象或数组
      if (typeof parsedContent === 'object' && parsedContent !== null) {
        return true;
      }
    } catch (e) {
      return false; // JSON 解析失败
    }
  }

  return false;
}

function preprocessMessages(messages) {
  return messages.map(message => {
    // 如果消息内容是字符串但看起来像JSON，尝试解析它
    if (typeof message.content === 'string' &&
      (message.content.startsWith('{') || message.content.startsWith('['))) {
      try {
        // 尝试解析JSON字符串
        const parsedContent = JSON.parse(message.content);
        // 将解析后的内容转换为文本格式
        return {
          role: message.role,
          content: JSON.stringify(parsedContent, null, 2)
        };
      } catch (e) {
        // 如果解析失败，保持原样
        return message;
      }
    }
    return message;
  });
}

async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const hasImageContent = req.body.messages.some(msg =>
      Array.isArray(msg.content) &&
      msg.content.some(item => item.type === 'image_url')
    );

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...preprocessMessages(req.body.messages)
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 45000
    };

    try {
      const moderationRequest = {
        messages: moderationMessages,
        model: firstProviderModel,
        stream: false,
        temperature: 0,
        response_format: {
          type: "json_object"
        },
        tools: req.body.tools || [] // 添加 tools 参数支持
      };

      if (hasImageContent) {
        moderationRequest.max_tokens = req.body.max_tokens || 8192;
      } else {
        moderationRequest.max_tokens = 100;
      }

      const checkResponse = await axios.post(
        firstProviderUrl + '/v1/chat/completions',
        moderationRequest,
        firstProviderConfig
      );

      try {
        const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
        if (moderationResult.isViolation === true) {
          res.write(`data: ${JSON.stringify({
            error: {
              message: "Content violation detected",
              type: "content_filter_error",
              code: "content_violation"
            }
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      } catch (parseError) {
        console.error('Moderation parsing error:', parseError);
        throw new Error('Invalid moderation response format');
      }

      const secondProviderRequest = {
        ...req.body,
        stream: true,
        tools: req.body.tools || [] // 添加 tools 参数支持
      };

      if (hasImageContent) {
        secondProviderRequest.max_tokens = req.body.max_tokens || 8192;
      }

      const response = await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        {
          ...secondProviderConfig,
          responseType: 'stream'
        }
      );

      response.data.pipe(res);
    } catch (providerError) {
      console.error('Provider error:', providerError);
      const errorResponse = handleError(providerError);
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    console.error('Stream handler error:', error);
    const errorResponse = handleError(error);
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  try {
    const hasImageContent = req.body.messages.some(msg =>
      Array.isArray(msg.content) &&
      msg.content.some(item => item.type === 'image_url')
    );

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...preprocessMessages(req.body.messages)
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 45000
    };

    try {
      const moderationRequest = {
        messages: moderationMessages,
        model: firstProviderModel,
        temperature: 0,
        response_format: {
          type: "json_object"
        },
        tools: req.body.tools || [] // 添加 tools 参数支持
      };

      if (hasImageContent) {
        moderationRequest.max_tokens = req.body.max_tokens || 8192;
      } else {
        moderationRequest.max_tokens = 100;
      }

      const checkResponse = await axios.post(
        firstProviderUrl + '/v1/chat/completions',
        moderationRequest,
        firstProviderConfig
      );

      try {
        const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
        if (moderationResult.isViolation === true) {
          return res.status(403).json({
            error: {
              message: "Content violation detected",
              type: "content_filter_error",
              code: "content_violation"
            }
          });
        }
      } catch (parseError) {
        console.error('Moderation parsing error:', parseError);
        throw new Error('Invalid moderation response format');
      }

      const secondProviderRequest = {
        ...req.body,
        tools: req.body.tools || [] // 添加 tools 参数支持
      };

      if (hasImageContent) {
        secondProviderRequest.max_tokens = req.body.max_tokens || 8192;
      }

      const response = await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        secondProviderConfig
      );

      res.json(response.data);
    } catch (providerError) {
      console.error('Provider error:', providerError);
      const errorResponse = handleError(providerError);
      res.status(errorResponse.error.code).json(errorResponse);
    }
  } catch (error) {
    console.error('Normal handler error:', error);
    const errorResponse = handleError(error);
    res.status(errorResponse.error.code).json(errorResponse);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    });
  }

  // 验证API访问密钥
  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const validAuthKey = process.env.AUTH_KEY;

  if (!authKey || authKey !== validAuthKey) {
    return res.status(401).json({
      error: {
        message: "Invalid authentication key",
        type: "invalid_request_error",
        code: "invalid_auth_key"
      }
    });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: {
        message: "Invalid request body",
        type: "invalid_request_error",
        code: "invalid_body"
      }
    });
  }

  // 验证消息格式
  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
  }

  // 修改消息验证部分
  for (const message of req.body.messages) {
    if (!validateMessage(message)) {
      console.error('Invalid message format:', JSON.stringify(message, null, 2));  // 添加详细日志
      return res.status(400).json({
        error: {
          message: "Invalid message format",
          type: "invalid_request_error",
          code: "invalid_message_format",
          details: "Each message must have a valid role and content",
          invalidMessage: message  // 添加具体的无效消息信息
        }
      });
    }
  }

  // 验证模型
  if (!req.body.model) {
    return res.status(400).json({
      error: {
        message: "model is required",
        type: "invalid_request_error",
        code: "invalid_model"
      }
    });
  }

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const firstProviderModel = process.env.FIRST_PROVIDER_MODEL;
  const firstProviderKey = process.env.FIRST_PROVIDER_KEY;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  // 检查所有必需的环境变量
  const missingVars = [];
  if (!firstProviderUrl) missingVars.push('FIRST_PROVIDER_URL');
  if (!secondProviderUrl) missingVars.push('SECOND_PROVIDER_URL');
  if (!firstProviderModel) missingVars.push('FIRST_PROVIDER_MODEL');
  if (!firstProviderKey) missingVars.push('FIRST_PROVIDER_KEY');
  if (!secondProviderKey) missingVars.push('SECOND_PROVIDER_KEY');
  if (!validAuthKey) missingVars.push('AUTH_KEY');

  if (missingVars.length > 0) {
    return res.status(500).json({
      error: {
        message: "Missing required environment variables",
        type: "configuration_error",
        code: "provider_not_configured",
        details: `Missing: ${missingVars.join(', ')}`
      }
    });
  }

  try {
    if (req.body.stream) {
      await handleStream(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
        firstProviderKey,
        secondProviderKey
      );
    } else {
      await handleNormal(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
        firstProviderKey,
        secondProviderKey
      );
    }
  } catch (error) {
    const errorResponse = handleError(error);
    res.status(errorResponse.error.code).json(errorResponse);
  }
};