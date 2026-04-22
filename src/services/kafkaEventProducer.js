const { Kafka } = require("kafkajs");

class KafkaEventProducer {
  constructor(kafkaConfig) {
    this.kafkaConfig = kafkaConfig;
    this.producer = null;
    this.enabled = kafkaConfig.brokers.length > 0;
  }

  async connect() {
    if (!this.enabled) return;
    const kafka = new Kafka({
      clientId: this.kafkaConfig.clientId,
      brokers: this.kafkaConfig.brokers
    });
    this.producer = kafka.producer();
    await this.producer.connect();
  }

  async publish(envelope) {
    if (!this.enabled || !this.producer) return;
    await this.producer.send({
      topic: this.kafkaConfig.topic,
      messages: [{ key: envelope.sessionId || envelope.eventId, value: JSON.stringify(envelope) }]
    });
  }

  async disconnect() {
    if (this.producer) {
      await this.producer.disconnect();
    }
  }
}

module.exports = { KafkaEventProducer };
