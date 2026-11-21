package jp.gekko13.auth;

import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;

/**
 * 認可の記録を読み戻すときに使う、クライアントの登録。サービスの登録に、取り込んだ A のクライアント（customer-app）を足す。
 * JDBC の保存は、記録を読み戻すときに、記録のクライアントを登録から引く。customer-app は、この認可サーバーで認証する窓口ではないので、
 * 認証に使う登録（RegisteredClientRepository の Bean）には足さず、読み戻しのときだけ引けるようにする。
 */
final class ImportedClients implements RegisteredClientRepository {

	private final RegisteredClientRepository services;

	ImportedClients(RegisteredClientRepository services) {
		this.services = services;
	}

	@Override
	public void save(RegisteredClient registeredClient) {
		throw new UnsupportedOperationException("登録は設定から作る");
	}

	@Override
	public RegisteredClient findById(String id) {
		return ExternalSubjectImporter.CUSTOMER_APP.getId().equals(id) ? ExternalSubjectImporter.CUSTOMER_APP
				: this.services.findById(id);
	}

	@Override
	public RegisteredClient findByClientId(String clientId) {
		return ExternalSubjectImporter.CUSTOMER_APP.getClientId().equals(clientId) ? ExternalSubjectImporter.CUSTOMER_APP
				: this.services.findByClientId(clientId);
	}

}
