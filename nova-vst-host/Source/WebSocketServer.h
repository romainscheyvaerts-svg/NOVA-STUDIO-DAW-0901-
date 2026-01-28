/*
  ==============================================================================
    Nova VST Host - WebSocket Server Header
    
    Serveur WebSocket pour communication avec le DAW web
  ==============================================================================
*/

#pragma once

#include <JuceHeader.h>
#include <map>
#include <set>

class WebSocketServer : private juce::Thread
{
public:
    class Listener
    {
    public:
        virtual ~Listener() = default;
        virtual void onMessageReceived(const juce::String& clientId, const juce::var& message) = 0;
        virtual void onClientConnected(const juce::String& clientId) = 0;
        virtual void onClientDisconnected(const juce::String& clientId) = 0;
    };
    
    WebSocketServer(int port);
    ~WebSocketServer() override;
    
    void start();
    void stop();
    
    void addListener(Listener* listener);
    void removeListener(Listener* listener);
    
    void send(const juce::String& clientId, const juce::var& message);
    void broadcast(const juce::var& message);
    
private:
    void run() override;
    
    int serverPort;
    std::unique_ptr<juce::StreamingSocket> serverSocket;
    
    struct Client
    {
        std::unique_ptr<juce::StreamingSocket> socket;
        juce::String id;
        bool isWebSocket = false;
    };
    
    std::map<juce::String, std::unique_ptr<Client>> clients;
    juce::CriticalSection clientLock;
    
    std::set<Listener*> listeners;
    juce::CriticalSection listenerLock;
    
    void handleNewConnection(std::unique_ptr<juce::StreamingSocket> socket);
    void handleClientMessage(Client& client);
    void performWebSocketHandshake(Client& client, const juce::String& request);
    void sendWebSocketFrame(juce::StreamingSocket& socket, const juce::String& message);
    juce::String decodeWebSocketFrame(const char* data, int length);
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebSocketServer)
};
