/*
  ==============================================================================
    Nova VST Host - WebSocket Server Implementation
  ==============================================================================
*/

#include "WebSocketServer.h"

#if JUCE_WINDOWS
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")
#endif

WebSocketServer::WebSocketServer(int port)
    : Thread("WebSocketServer"), serverPort(port)
{
}

WebSocketServer::~WebSocketServer()
{
    stop();
}

void WebSocketServer::start()
{
    serverSocket = std::make_unique<juce::StreamingSocket>();
    
    if (serverSocket->createListener(serverPort))
    {
        DBG("WebSocket server listening on port " + juce::String(serverPort));
        startThread();
    }
    else
    {
        DBG("Failed to create server on port " + juce::String(serverPort));
    }
}

void WebSocketServer::stop()
{
    signalThreadShouldExit();
    
    if (serverSocket)
    {
        serverSocket->close();
    }
    
    {
        juce::ScopedLock lock(clientLock);
        for (auto& [id, client] : clients)
        {
            if (client->socket)
                client->socket->close();
        }
        clients.clear();
    }
    
    waitForThreadToExit(3000);
}

void WebSocketServer::addListener(Listener* listener)
{
    juce::ScopedLock lock(listenerLock);
    listeners.insert(listener);
}

void WebSocketServer::removeListener(Listener* listener)
{
    juce::ScopedLock lock(listenerLock);
    listeners.erase(listener);
}

void WebSocketServer::run()
{
    while (!threadShouldExit())
    {
        // Accept new connections (with internal timeout handling)
        // Note: waitForNextConnection will return nullptr if server socket is closed
        auto newSocket = std::unique_ptr<juce::StreamingSocket>(
            serverSocket->waitForNextConnection()
        );
        
        if (newSocket && newSocket->isConnected())
        {
            DBG("WebSocket: New connection accepted");
            handleNewConnection(std::move(newSocket));
        }
        
        // Process existing clients
        juce::ScopedLock lock(clientLock);
        
        std::vector<juce::String> toRemove;
        
        for (auto& [id, client] : clients)
        {
            if (!client->socket || !client->socket->isConnected())
            {
                toRemove.push_back(id);
                continue;
            }
            
            if (client->socket->waitUntilReady(false, 1) == 1)
            {
                handleClientMessage(*client);
            }
        }
        
        // Remove disconnected clients
        for (auto& id : toRemove)
        {
            clients.erase(id);
            
            juce::ScopedLock llock(listenerLock);
            for (auto* listener : listeners)
            {
                juce::MessageManager::callAsync([listener, id]() {
                    listener->onClientDisconnected(id);
                });
            }
        }
        
        Thread::sleep(1);
    }
}

void WebSocketServer::handleNewConnection(std::unique_ptr<juce::StreamingSocket> socket)
{
    auto clientId = "client_" + juce::String(juce::Time::currentTimeMillis());
    
    auto client = std::make_unique<Client>();
    client->socket = std::move(socket);
    client->id = clientId;
    client->isWebSocket = false;
    
    // Wait for HTTP upgrade request (with timeout)
    int ready = client->socket->waitUntilReady(true, 5000);  // Wait up to 5 seconds for data
    
    if (ready != 1)
    {
        DBG("WebSocket: Client connection timed out or error");
        return;
    }
    
    char buffer[4096] = {0};
    int bytesRead = client->socket->read(buffer, sizeof(buffer) - 1, true);  // Blocking read
    
    DBG("WebSocket: Received " + juce::String(bytesRead) + " bytes from new connection");
    
    if (bytesRead > 0)
    {
        juce::String request(buffer, bytesRead);
        
        DBG("WebSocket: Request contains Upgrade: " + juce::String(request.contains("Upgrade: websocket")));
        
        if (request.contains("Upgrade: websocket") || request.containsIgnoreCase("upgrade: websocket"))
        {
            performWebSocketHandshake(*client, request);
            client->isWebSocket = true;
            
            DBG("WebSocket: Handshake completed for " + clientId);
            
            {
                juce::ScopedLock lock(clientLock);
                clients[clientId] = std::move(client);
            }
            
            juce::ScopedLock lock(listenerLock);
            for (auto* listener : listeners)
            {
                juce::MessageManager::callAsync([listener, clientId]() {
                    listener->onClientConnected(clientId);
                });
            }
        }
        else
        {
            DBG("WebSocket: Not a WebSocket upgrade request");
        }
    }
}

void WebSocketServer::performWebSocketHandshake(Client& client, const juce::String& request)
{
    // Extract Sec-WebSocket-Key
    juce::String key;
    auto lines = juce::StringArray::fromLines(request);
    
    for (auto& line : lines)
    {
        if (line.startsWithIgnoreCase("Sec-WebSocket-Key:"))
        {
            key = line.substring(18).trim();
            break;
        }
    }
    
    if (key.isEmpty())
        return;
    
    // Generate accept key using SHA-1 with Windows Crypto API
    auto acceptKey = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    
    juce::String base64Accept;
    
#if JUCE_WINDOWS
    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    BYTE hashBuffer[20] = {0}; // SHA1 produces 20 bytes
    DWORD hashLength = 20;
    
    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) == 0)
    {
        if (BCryptCreateHash(hAlg, &hHash, nullptr, 0, nullptr, 0, 0) == 0)
        {
            auto utf8Data = acceptKey.toUTF8();
            BCryptHashData(hHash, (PUCHAR)utf8Data.getAddress(), (ULONG)utf8Data.length(), 0);
            BCryptFinishHash(hHash, hashBuffer, hashLength, 0);
            BCryptDestroyHash(hHash);
        }
        BCryptCloseAlgorithmProvider(hAlg, 0);
    }
    
    base64Accept = juce::Base64::toBase64(hashBuffer, hashLength);
#endif
    
    // Send handshake response
    juce::String response;
    response << "HTTP/1.1 101 Switching Protocols\r\n";
    response << "Upgrade: websocket\r\n";
    response << "Connection: Upgrade\r\n";
    response << "Sec-WebSocket-Accept: " << base64Accept << "\r\n";
    response << "\r\n";
    
    client.socket->write(response.toRawUTF8(), (int)response.length());
}

void WebSocketServer::handleClientMessage(Client& client)
{
    char buffer[65536] = {0};
    int bytesRead = client.socket->read(buffer, sizeof(buffer), false);
    
    if (bytesRead <= 0)
        return;
    
    if (!client.isWebSocket)
        return;
    
    // Decode WebSocket frame
    auto message = decodeWebSocketFrame(buffer, bytesRead);
    
    if (message.isEmpty())
        return;
    
    // Parse JSON
    auto json = juce::JSON::parse(message);
    
    if (!json.isVoid())
    {
        juce::ScopedLock lock(listenerLock);
        for (auto* listener : listeners)
        {
            auto clientId = client.id;
            juce::MessageManager::callAsync([listener, clientId, json]() {
                listener->onMessageReceived(clientId, json);
            });
        }
    }
}

juce::String WebSocketServer::decodeWebSocketFrame(const char* data, int length)
{
    if (length < 2)
        return {};
    
    unsigned char firstByte = data[0];
    unsigned char secondByte = data[1];
    
    // Check opcode (0x1 = text frame)
    int opcode = firstByte & 0x0F;
    if (opcode != 0x01 && opcode != 0x02)
        return {};
    
    bool masked = (secondByte & 0x80) != 0;
    int payloadLength = secondByte & 0x7F;
    
    int offset = 2;
    
    if (payloadLength == 126)
    {
        if (length < 4) return {};
        payloadLength = (unsigned char)data[2] << 8 | (unsigned char)data[3];
        offset = 4;
    }
    else if (payloadLength == 127)
    {
        if (length < 10) return {};
        // Handle 64-bit length (simplified)
        payloadLength = (unsigned char)data[6] << 24 | (unsigned char)data[7] << 16 |
                       (unsigned char)data[8] << 8 | (unsigned char)data[9];
        offset = 10;
    }
    
    const char* maskKey = nullptr;
    if (masked)
    {
        if (length < offset + 4) return {};
        maskKey = data + offset;
        offset += 4;
    }
    
    if (length < offset + payloadLength)
        return {};
    
    // Decode payload
    juce::String result;
    result.preallocateBytes(payloadLength + 1);
    
    for (int i = 0; i < payloadLength; ++i)
    {
        char c = data[offset + i];
        if (masked)
            c ^= maskKey[i % 4];
        result += c;
    }
    
    return result;
}

void WebSocketServer::send(const juce::String& clientId, const juce::var& message)
{
    juce::ScopedLock lock(clientLock);
    
    auto it = clients.find(clientId);
    if (it == clients.end() || !it->second->socket || !it->second->isWebSocket)
        return;
    
    auto jsonStr = juce::JSON::toString(message);
    sendWebSocketFrame(*it->second->socket, jsonStr);
}

void WebSocketServer::broadcast(const juce::var& message)
{
    auto jsonStr = juce::JSON::toString(message);
    
    juce::ScopedLock lock(clientLock);
    
    for (auto& [id, client] : clients)
    {
        if (client->socket && client->isWebSocket)
        {
            sendWebSocketFrame(*client->socket, jsonStr);
        }
    }
}

void WebSocketServer::sendWebSocketFrame(juce::StreamingSocket& socket, const juce::String& message)
{
    auto utf8 = message.toUTF8();
    int length = (int)utf8.length();
    
    std::vector<char> frame;
    
    // FIN bit + text opcode
    frame.push_back((char)0x81);
    
    // Payload length
    if (length < 126)
    {
        frame.push_back((char)length);
    }
    else if (length < 65536)
    {
        frame.push_back((char)126);
        frame.push_back((char)(length >> 8));
        frame.push_back((char)(length & 0xFF));
    }
    else
    {
        frame.push_back((char)127);
        for (int i = 7; i >= 0; --i)
        {
            frame.push_back((char)((length >> (i * 8)) & 0xFF));
        }
    }
    
    // Payload
    for (int i = 0; i < length; ++i)
    {
        frame.push_back(utf8.getAddress()[i]);
    }
    
    socket.write(frame.data(), (int)frame.size());
}
