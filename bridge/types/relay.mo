module {
  /// A file attached to a relayed email, its content base64-encoded.
  public type RelayAttachment = {
    filename : Text;
    base64 : Text;
  };

  /// An email the email-canister backend asks this canister to send from the domain.
  /// `outboxId` identifies the email: a repeated call never sends it twice.
  public type RelayRequest = {
    outboxId : Text;
    fromUsername : Text;
    to : [Text];
    cc : [Text];
    bcc : [Text];
    subject : Text;
    htmlBody : Text;
    attachments : [RelayAttachment];
  };

  /// What happened to a relayed email.
  public type RelayStatus = {
    /// Still being sent; started at this time, in nanoseconds since the epoch. Ask again later.
    #sending : Int;
    /// Accepted by the mail gateway. Delivery itself is not reported.
    #sent;
    /// Certainly not sent: refused by the mail gateway, or never posted to it.
    /// Kept: a repeated call with the same outboxId reports it again, even
    /// after the cause is fixed. Sending it again takes a new outboxId.
    #rejected : Text;
    /// The outcome was lost, so it may or may not have been sent. Do not resend
    /// without asking the person who wrote it.
    #unknown : Text;
  };
};
